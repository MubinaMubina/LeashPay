import { keccak256, parseUnits, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { buildPlan, isExecutable } from "../src/plan/build";
import type { RecipientEntry } from "../src/plan/directory";
import type { PlanDraft } from "../src/plan/schema";
import { ATTACKER, LINH, MARCO, OWNER, VAULT, short } from "./fakes";

const directory: RecipientEntry[] = [
  { name: "Linh", address: LINH, country: "Vietnam", currency: "VND", preferredToken: "USDC" },
  { name: "Marco", address: MARCO, country: "Philippines", currency: "PHP" },
];

const ctx = { id: "plan-1", owner: OWNER, vault: VAULT, message: "test", directory, now: new Date("2026-11-25T12:00:00Z") };

function draft(payments: PlanDraft["payments"], notes: string[] = []): PlanDraft {
  return { kind: "payment", payments, scheduled_for: "now", notes };
}

describe("buildPlan", () => {
  it("resolves directory names, parses amounts and applies preferred tokens", () => {
    const plan = buildPlan(
      draft([
        { recipient_name: "linh", recipient_address: "", amount: "300", currency: "USD" },
        { recipient_name: "Marco", recipient_address: MARCO, amount: "1,000.50", currency: "USD" },
      ]),
      ctx,
    );

    expect(plan.payments).toHaveLength(2);
    expect(plan.payments[0]).toMatchObject({ recipientName: "Linh", recipient: LINH, amount: parseUnits("300", 18), token: "USDC", warnings: [] });
    expect(plan.payments[1]).toMatchObject({ recipient: MARCO, amount: parseUnits("1000.5", 18), token: "USDT" });
    expect(plan.payments.every(isExecutable)).toBe(true);
  });

  it("keeps an unknown address executable but warns: the vault decides, not the agent", () => {
    const plan = buildPlan(draft([{ recipient_name: "URGENT", recipient_address: ATTACKER, amount: "5000", currency: "USD" }]), ctx);
    const [payment] = plan.payments;
    expect(payment?.recipient).toBe(ATTACKER);
    expect(payment && isExecutable(payment)).toBe(true);
    expect(payment?.warnings).toEqual([`${short(ATTACKER)} is not in your recipient directory.`]);
  });

  it("can't pay a name it can't resolve", () => {
    const plan = buildPlan(draft([{ recipient_name: "Bob", recipient_address: "", amount: "50", currency: "USD" }]), ctx);
    expect(plan.payments[0]?.recipient).toBeNull();
    expect(plan.payments[0]?.warnings).toEqual(["Bob is not in your recipient directory."]);
    expect(plan.payments.some(isExecutable)).toBe(false);
  });

  it("rejects a malformed address but still finds the person by name", () => {
    const plan = buildPlan(draft([{ recipient_name: "Marco", recipient_address: "0x123", amount: "10", currency: "USD" }]), ctx);
    expect(plan.payments[0]?.recipient).toBe(MARCO);
    expect(plan.payments[0]?.warnings).toEqual(['"0x123" is not a valid address.']);
  });

  it("doesn't guess exchange rates for other currencies", () => {
    const plan = buildPlan(draft([{ recipient_name: "Linh", recipient_address: "", amount: "7000000", currency: "VND" }]), ctx);
    expect(plan.payments[0]?.amount).toBeNull();
    expect(plan.payments[0]?.warnings[0]).toContain("VND need a currency conversion");
  });

  it("rejects amounts that aren't positive numbers", () => {
    const plan = buildPlan(
      draft([
        { recipient_name: "Linh", recipient_address: "", amount: "three hundred", currency: "USD" },
        { recipient_name: "Marco", recipient_address: "", amount: "0", currency: "USD" },
      ]),
      ctx,
    );
    expect(plan.payments.map((p) => p.amount)).toEqual([null, null]);
  });

  it("merges two payments to the same person, since a plan pays each person once", () => {
    const plan = buildPlan(
      draft([
        { recipient_name: "Marco", recipient_address: "", amount: "100", currency: "USD" },
        { recipient_name: "Marco", recipient_address: "", amount: "50", currency: "USD" },
      ]),
      ctx,
    );
    expect(plan.payments).toHaveLength(1);
    expect(plan.payments[0]?.amount).toBe(parseUnits("150", 18));
    expect(plan.notes).toContain("Combined two payments to Marco into one: a plan pays each person once.");
  });

  it("won't pay one person in two coins within one plan", () => {
    const plan = buildPlan(
      draft([
        { recipient_name: "Marco", recipient_address: "", amount: "100", currency: "USDT" },
        { recipient_name: "Marco", recipient_address: "", amount: "50", currency: "USDC" },
      ]),
      ctx,
    );
    expect(plan.payments).toHaveLength(2);
    expect(plan.payments[1]?.amount).toBeNull();
  });

  it("derives the on-chain ref from the plan id", () => {
    expect(buildPlan(draft([]), ctx).ref).toBe(keccak256(toHex("plan-1")));
  });
});
