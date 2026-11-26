import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseUnits } from "viem";
import { describe, expect, it, vi } from "vitest";
import { PlanCard } from "@/components/PlanCard";
import type { JournalEventJson, PaymentJson, PlanJson } from "@/lib/plan-progress";

vi.mock("@privy-io/react-auth", () => ({ useSignMessage: () => ({ signMessage: vi.fn() }) }));
vi.mock("@/lib/client", () => ({ useApi: () => vi.fn(), useOwnerWallet: () => ({ address: owner }) }));
const address = (n: number) => `0x${String(n).padStart(40, "0")}` as const;
const owner = address(1);
const fee = { token: "USDT" as const, amount: String(parseUnits("0.01", 18)), recipient: address(9) };
const raw = (amount: string) => String(parseUnits(amount, 18));
function row(n: number, amount: string, token: PaymentJson["token"]): PaymentJson {
  return { recipientName: `Person ${n}`, recipient: address(n), amount: raw(amount), token, warnings: [], preview: null };
}
function review(payments: PaymentJson[], initialEvents: JournalEventJson[] = [], paymentFee: PlanJson["paymentFee"] | null = fee) {
  const plan: PlanJson = { id: "batch", ref: "0x1234", vault: address(2), owner, kind: "payment",
    createdAt: "2026-11-27", scheduledFor: "now", message: "Pay team", notes: [], payments,
    ...(paymentFee ? { paymentFee } : {}) };
  return renderToStaticMarkup(createElement(PlanCard, { plan, initialEvents, onSettled: vi.fn(), onAgentDown: vi.fn() }))
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("fee-bearing payout reviews and receipts", () => {
  it("shows mixed-token maximum debits, including the USDT fee on USDC payouts, before approval", () => {
    const view = review([row(3, "3", "USDT"), row(4, "2.000000000000000001", "USDC")]);
    expect(view).toContain("0.01 USDT per successful payment");
    expect(view).toContain("Maximum payment fees 0.02 USDT");
    expect(view).toContain("Maximum vault debit 3.02 USDT + 2.000000000000000001 USDC");
    expect(view.indexOf("Maximum vault debit")).toBeLessThan(view.indexOf("Approve with wallet"));
    expect(view).not.toContain("Confirmed fees");
  });

  it("charges once for a merged recipient, omits held-back and unresolved rows, and keeps both coins separate", () => {
    const combined = row(3, "7", "USDC");
    const withheld = { ...combined, token: "USDT" as const, amount: null };
    const unresolved = { ...row(5, "50", "USDT"), recipient: null };
    const view = review([combined, withheld, unresolved]);
    expect(view).toContain("Maximum payment fees 0.01 USDT");
    expect(view).toContain("Maximum vault debit 0.01 USDT + 7 USDC");
    expect(view).not.toContain("50.01 USDT");
  });

  it("keeps planned maximums separate from confirmed charges on a restored partial receipt", () => {
    const view = review([row(3, "5", "USDT"), row(4, "12", "USDC"), row(5, "2", "USDT")], [
      { type: "step_succeeded", index: 1, at: "2026-11-27", hash: "0xabc" },
      { type: "step_failed", index: 0, at: "2026-11-27", hash: "0xdef", error: "Reverted" },
      { type: "step_sent", index: 2, at: "2026-11-27", hash: "0xfcd" },
    ]);
    expect(view).toContain("Maximum vault debit 7.03 USDT + 12 USDC");
    expect(view).toContain("Confirmed fees 0.01 USDT");
    expect(view).toContain("Confirmed vault debit 0.01 USDT + 12 USDC");
  });

  it("reports zero confirmed charges for a refused payment", () => {
    const preview = { name: "InsufficientBalance", args: [], message: "Insufficient balance" };
    const view = review([{ ...row(3, "100", "USDT"), preview }],
      [{ type: "step_refused", at: "2026-11-27", index: 0, error: preview }]);
    expect(view).toContain("Maximum vault debit 100.01 USDT");
    expect(view).toContain("Confirmed fees 0 USDT");
    expect(view).toContain("Confirmed vault debit 0 USDT");
  });

  it("keeps legacy approvals and receipts free of fabricated fees", () => {
    expect(review([row(3, "100", "USDT")], [], null)).not.toMatch(/payment fees|successful payment|vault debit/i);
  });
});
