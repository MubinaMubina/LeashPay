import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RecipientBook } from "@/lib/recipient-book";
import type { ListedRecipient } from "@/lib/recipients";
import { PaymentDraftCard } from "@/components/PaymentDraftCard";
import { draftFields, initialRecipient, paymentReviewMessage } from "@/lib/payment-draft";
import { requestPaymentReview } from "@/lib/chat-turn";

const lea: ListedRecipient = {
  name: "Léa", address: "0x1111111111111111111111111111111111111111",
  onChain: { allowed: true, monthlyCap: 500n * 10n ** 18n, spentThisMonth: 0n },
};
const linh: ListedRecipient = { ...lea, name: "Linh", address: "0x2222222222222222222222222222222222222222" };
const directory = [lea, linh];

describe("payment draft fields", () => {
  it("keeps the supplied amount while the owner chooses an unknown recipient", () => {
    expect(draftFields(["send 200 test"], directory)).toEqual({ amount: "200", token: "auto", recipient: "test" });
    expect(initialRecipient("test", directory, ["Linh"])).toBe("");
  });

  it("combines complementary owner turns and keeps the requested coin", () => {
    expect(draftFields(["Pay Léa", "00025.500 USDC"], directory))
      .toEqual({ amount: "25.5", token: "USDC", recipient: "Léa" });
    expect(draftFields(["Envoie 025.50 USDT à Linh"], directory))
      .toEqual({ amount: "25.5", token: "USDT", recipient: "Linh" });
    expect(draftFields(["Pay 25 USD", "Léa"], directory))
      .toEqual({ amount: "25", token: "auto", recipient: "Léa" });
  });

  it("keeps the amount empty on a menu or payee-only request and never selects a candidate alone", () => {
    expect(draftFields([], directory)).toEqual({ amount: "", token: "auto", recipient: "" });
    expect(draftFields(["Pay Léa"], directory)).toEqual({ amount: "", token: "auto", recipient: "Léa" });
    expect(initialRecipient("léa", directory)).toBe(lea.address);
    expect(initialRecipient("lea", directory)).toBe("");
    expect(initialRecipient("", directory, ["Linh"])).toBe("");
  });

  it("requires a choice for conflicting identities, partial names and unverified access", () => {
    const otherLea = { ...linh, name: "LÉA", onChain: null };
    expect(initialRecipient("Léa", [lea, otherLea])).toBe("");
    expect(initialRecipient("Léa", [otherLea])).toBe("");
    expect(initialRecipient("Léa", [{ ...lea, onChain: { ...lea.onChain!, allowed: false } }])).toBe("");
    expect(initialRecipient("Lé", directory, ["Léa"])).toBe("");
    expect(initialRecipient("Léa", directory, ["Léa", "Linh"])).toBe("");
  });

  it("keeps a possible asset intact even if a saved contact has the same name", () => {
    expect(draftFields(["send 20 ETH"], [{ ...lea, name: "ETH" }])).toBeNull();
  });

  it("does not read a negative answer to a missing recipient as a name", () => {
    expect(draftFields(["Pay 25", "no"], directory)).toBeNull();
  });

  it.each(["her", "lui", "le deuxième", "the second one", "option 2", "I mean the last one, please", "oui"])
  ("leaves the recipient unselected for the ambiguous answer %s, even when a contact has that name", answer => {
    const lookalike = [{ ...lea, name: answer }];
    expect(draftFields(["Pay 25 USDC", answer], lookalike)).toEqual({ amount: "25", token: "USDC", recipient: "" });
    expect(initialRecipient(answer, lookalike)).toBe("");
  });

  it("clears an earlier name on a positional reply, and keeps scheduled dates in the original instructions", () => {
    expect(draftFields(["Pay Léa 25", "the second one"], directory)).toEqual({ recipient: "", token: "auto", amount: "25" });
    expect(draftFields(["Pay Léa 25", "on the 2nd of June"], directory)).toBeNull();
  });

  it("can review an explicit address selection for a contact named Her", () => {
    const people = [{ ...lea, name: "Her" }];
    expect(draftFields(["Pay her 25"], people)).toEqual({ recipient: "", token: "auto", amount: "25" });
    expect(paymentReviewMessage(lea.address, "25", "auto", people)).toBe("Pay 25 to " + lea.address);
  });

  it.each([
    ["Pay Léa 20 and Linh 30"], ["Pay 20 EUR to Léa"], ["send 200 THB"], ["send 200 eth"],
    ["Pay Léa 40 tomorrow"], ["send 200 tomorrow"], ["Pay Léa 20 if she delivers"], ["Don't pay Léa 20"],
    ["Pay Léa -20"], ["send -20 to Léa"], ["Pay Léa 1,50"], ["Pay Léa 20 to " + linh.address],
    ["Pay Léa", "Linh"], ["Pay Léa 20 USDC", "25 USDT"], ["Pay Léa 20", "once she confirms"],
  ])("keeps all of the original instructions for %s", (...source) => {
    expect(draftFields(source, directory)).toBeNull();
  });

  it("uses the selected authorized address and the canonical amount in the review, preserving token choice", () => {
    expect(paymentReviewMessage(lea.address, "0001.2500", "USDC", directory))
      .toBe("Pay 1.25 USDC to 0x1111111111111111111111111111111111111111");
    expect(paymentReviewMessage(linh.address, ".5", "auto", directory))
      .toBe("Pay 0.5 to 0x2222222222222222222222222222222222222222");
    expect(paymentReviewMessage(lea.address, "0.000000000000000001", "USDT", directory))
      .toBe("Pay 0.000000000000000001 USDT to 0x1111111111111111111111111111111111111111");
  });

  it.each(["", "0", "-2", "1e4", "1,000", "2.0000000000000000001", "1000000000.01"])
  ("blocks review with an invalid token amount %s", amount => {
    expect(paymentReviewMessage(lea.address, amount, "USDT", directory)).toBeNull();
  });

  it("blocks review when the selected address disappears or loses authorization", () => {
    expect(paymentReviewMessage(lea.address, "2", "USDT", [linh])).toBeNull();
    expect(paymentReviewMessage(lea.address, "2", "USDT", [{ ...lea, onChain: null }])).toBeNull();
  });

  it("reopens an unavailable quote by its verified address, even when another contact has the same name", async () => {
    const sameNames = [lea, { ...linh, name: "Léa" }];
    const message = paymentReviewMessage(linh.address, "200", "USDC", sameNames)!;
    const unavailable = vi.fn().mockResolvedValue({ ok: false, status: 503, body: { error: "Unavailable" } });
    const result = await requestPaymentReview(unavailable, lea.address, message, 1, () => true);
    if (result?.entry.kind !== "error") throw new Error("Expected a retryable error");
    const fields = draftFields([result.entry.retry.message], sameNames);
    expect(fields).toEqual({ amount: "200", token: "USDC", recipient: linh.address });
    expect(initialRecipient(fields!.recipient, sameNames)).toBe(linh.address);
    expect(paymentReviewMessage(initialRecipient(fields!.recipient, sameNames), "201", fields!.token, sameNames))
      .toBe("Pay 201 USDC to 0x2222222222222222222222222222222222222222");
  });

  it("keeps unknown addresses and extra conditions verbatim, including names that look like addresses", () => {
    const misleading = { ...lea, name: linh.address };
    expect(initialRecipient(linh.address, [misleading])).toBe("");
    expect(draftFields(["Pay 25 USDT to " + linh.address], [misleading])).toBeNull();
    expect(draftFields(["Pay 25 to " + lea.address + " on Friday"], directory)).toBeNull();
  });
});

function renderDraft(source: string[], list: RecipientBook["list"], error: string | null = null) {
  const book: RecipientBook = { list, error, revision: 0, refresh: vi.fn(), changed: vi.fn(), readDirectory: vi.fn() };
  return renderToStaticMarkup(createElement(PaymentDraftCard, {
    book, source, busy: false, onAddRecipient: vi.fn(), onReview: vi.fn(), onRequest: vi.fn(),
  }));
}

describe("payment preparation card", () => {
  it("shows a prefilled amount, a live-address selector, and both supported coins", () => {
    const html = renderDraft(["send 200 test"], [...directory, { ...linh, name: "Unverified", onChain: null }]);
    expect(html).toContain('value="200"');
    expect(html).toContain("Recipient");
    expect(html).toContain("Amount");
    expect(html).toContain("Review payment");
    expect(html).toContain(lea.address);
    expect(html).toContain("Léa");
    expect(html).toContain("Linh");
    expect(html).not.toContain("Unverified");
    expect(html).toContain("USDC");
    expect(html).toContain("USDT");
  });

  it("keeps the amount and offers real recovery actions when the directory read failed", () => {
    const html = renderDraft(["send 200 test"], null, "Directory unavailable");
    expect(html).toContain('value="200"');
    expect(html).toContain("Add recipient");
    expect(html).toContain("Retry");
    expect(html).toMatch(/<button[^>]+disabled[^>]*>Review payment/);
  });

  it("opens an editable request for a scheduled multi-payment with the original wording", () => {
    const html = renderDraft(["Pay Léa 20 and Linh 30", "next Friday"], directory);
    expect(html).toMatch(/<textarea[^>]*>Pay Léa 20 and Linh 30\nnext Friday<\/textarea>/);
    expect(html).toContain("Review payment");
    expect(html).toContain("Start a new single payment");
  });
});
