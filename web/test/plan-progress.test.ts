import { describe, expect, it } from "vitest";
import { SLOW_AFTER_MS, formatAmount, needsCheckAgain, rowStatus, type JournalEventJson, type PaymentJson } from "@/lib/plan-progress";

const payment = (over: Partial<PaymentJson> = {}): PaymentJson => ({
  recipientName: "Linh",
  recipient: "0x47D948f58f4a495283BF0F74257E2F73D446D7Ea",
  amount: "300000000000000000000",
  token: "USDT",
  warnings: [],
  preview: null,
  ...over,
});

const NOW = Date.parse("2026-11-26T05:00:10Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

describe("vault check labels before a run", () => {
  it("shows a pass only when the vault's check returned null", () => {
    expect(rowStatus(payment(), 0, [], NOW)).toMatchObject({ label: "Vault check passes", tone: "pass" });
  });

  it("shows the vault's refusal by name", () => {
    const refused = payment({ preview: { name: "RecipientNotAllowed", args: [], message: "This address isn't allowed." } });
    expect(rowStatus(refused, 0, [], NOW)).toMatchObject({ label: "Vault refuses: RecipientNotAllowed", tone: "stop" });
  });

  it("never turns a missing check into a pass", () => {
    const { preview: _, ...unchecked } = payment();
    expect(rowStatus(unchecked as PaymentJson, 0, [], NOW)).toMatchObject({ label: "Vault check unavailable", tone: "muted" });
  });

  it("marks a row with no recipient or amount as not payable", () => {
    expect(rowStatus(payment({ amount: null, warnings: ["No amount given."] }), 0, [], NOW)).toMatchObject({
      label: "Can't be paid",
      detail: "No amount given.",
    });
  });
});

describe("progress from journal events", () => {
  it("goes Sending… then Still confirming… then Paid ✓ with the transaction", () => {
    const sent: JournalEventJson = { type: "step_sent", at: at(1), index: 0, hash: "0xaaa" };
    expect(rowStatus(payment(), 0, [sent], NOW)).toMatchObject({ label: "Sending…", hash: "0xaaa" });

    const slowSent: JournalEventJson = { ...sent, at: at(SLOW_AFTER_MS / 1000 + 1) };
    expect(rowStatus(payment(), 0, [slowSent], NOW)).toMatchObject({ label: "Still confirming…", tone: "busy" });

    const paid: JournalEventJson = { type: "step_succeeded", at: at(0), index: 0, hash: "0xaaa" };
    expect(rowStatus(payment(), 0, [slowSent, paid], NOW)).toMatchObject({ label: "Paid ✓", tone: "pass", hash: "0xaaa" });
  });

  it("only reads events for its own row", () => {
    const other: JournalEventJson = { type: "step_succeeded", at: at(0), index: 1, hash: "0xbbb" };
    expect(rowStatus(payment(), 0, [other], NOW)).toMatchObject({ label: "Vault check passes" });
  });

  it("shows refusals and failures in red with the reason", () => {
    const refused: JournalEventJson = { type: "step_refused", at: at(0), index: 0, error: { name: "CooldownActive", args: [], message: "Wait a minute." } };
    expect(rowStatus(payment(), 0, [refused], NOW)).toMatchObject({ label: "Refused: CooldownActive", tone: "stop", detail: "Wait a minute." });
    const failed: JournalEventJson = { type: "step_failed", at: at(0), index: 0, hash: "0xccc", error: "Reverted." };
    expect(rowStatus(payment(), 0, [failed], NOW)).toMatchObject({ label: "Failed", tone: "stop", hash: "0xccc" });
  });

  it("keeps a payment the run reported as pending on Still confirming…, and offers Check again", () => {
    const sent: JournalEventJson = { type: "step_sent", at: at(1), index: 0, hash: "0xaaa" };
    const results = [{ index: 0, status: "pending" as const, hash: "0xaaa" }];
    expect(rowStatus(payment(), 0, [sent], NOW, results)).toMatchObject({ label: "Still confirming…", hash: "0xaaa" });
    expect(needsCheckAgain(results)).toBe(true);
    expect(needsCheckAgain([{ index: 0, status: "paid" }])).toBe(false);
  });
});

describe("formatAmount", () => {
  it("shows base units as tokens", () => {
    expect(formatAmount("300000000000000000000", "USDT")).toBe("300 USDT");
    expect(formatAmount("19050000000000000000000", "USDT")).toBe("19,050 USDT");
    expect(formatAmount(null, "USDT")).toBe("—");
  });
});
