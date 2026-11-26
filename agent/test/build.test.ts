import { keccak256, parseUnits, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { buildPlan, isDue, isExecutable, planLimitNotes } from "../src/plan/build";
import type { RecipientEntry } from "../src/plan/directory";
import type { PlanDraft } from "../src/plan/schema";
import { ATTACKER, FakeGateway, LINH, MARCO, OWNER, VAULT, short } from "./fakes";

const directory: RecipientEntry[] = [
  { name: "Linh", address: LINH, country: "Vietnam", currency: "VND", preferredToken: "USDC" },
  { name: "Marco", address: MARCO, country: "Philippines", currency: "PHP" },
];

const ctx = { id: "plan-1", owner: OWNER, vault: VAULT, message: "test", directory, now: new Date("2026-11-25T12:00:00Z") };

function draft(payments: PlanDraft["payments"], extra: Partial<PlanDraft> = {}): PlanDraft {
  return { kind: "payment", payments, scheduled_for: "now", notes: [], ...extra };
}
const pay = (recipient_name: string, amount: string, recipient_address = "", currency = "USD") => ({
  recipient_name,
  recipient_address,
  amount,
  currency,
});

describe("buildPlan", () => {
  it("resolves directory names, parses amounts and applies preferred tokens", () => {
    const plan = buildPlan(draft([pay("linh", "300"), pay("Marco", "1,000.50", MARCO)]), ctx);

    expect(plan.payments).toHaveLength(2);
    expect(plan.payments[0]).toMatchObject({ recipientName: "Linh", recipient: LINH, amount: parseUnits("300", 18), token: "USDC", warnings: [] });
    expect(plan.payments[1]).toMatchObject({ recipient: MARCO, amount: parseUnits("1000.5", 18), token: "USDT", warnings: [] });
    expect(plan.payments.every(isExecutable)).toBe(true);
  });

  it("keeps an unknown address executable but warns: the vault decides, not the agent", () => {
    const [payment] = buildPlan(draft([pay("URGENT", "5000", ATTACKER)]), ctx).payments;
    expect(payment?.recipient).toBe(ATTACKER);
    expect(payment && isExecutable(payment)).toBe(true);
    expect(payment?.warnings).toEqual([`${short(ATTACKER)} is not in your recipient directory.`]);
  });

  it("never lets a known name vouch for an unknown address", () => {
    const [payment] = buildPlan(draft([pay("Linh", "300", ATTACKER)]), ctx).payments;
    expect(payment).toMatchObject({ recipient: ATTACKER, recipientName: "Linh", token: "USDT" }); // not Linh's USDC
    expect(payment?.warnings).toEqual([
      `${short(ATTACKER)} is not Linh's address in your directory (${short(LINH)}). Check who this really is before paying.`,
    ]);
  });

  it("flags a name that points at someone else's address", () => {
    const [payment] = buildPlan(draft([pay("Linh", "300", MARCO)]), ctx).payments;
    expect(payment).toMatchObject({ recipient: MARCO, recipientName: "Marco" });
    expect(payment?.warnings).toEqual([`The message says Linh, but ${short(MARCO)} is Marco's address in your directory.`]);
  });

  it("won't guess between two recipients with the same name", () => {
    const twins = [...directory, { name: "linh", address: ATTACKER }];
    const [payment] = buildPlan(draft([pay("Linh", "300")]), { ...ctx, directory: twins }).payments;
    expect(payment?.recipient).toBeNull();
    expect(payment?.warnings).toEqual(["More than one recipient is named Linh. Use an address to pick one."]);
  });

  it("can't pay a name it can't resolve", () => {
    const plan = buildPlan(draft([pay("Bob", "50")]), ctx);
    expect(plan.payments[0]?.recipient).toBeNull();
    expect(plan.payments[0]?.warnings).toEqual(["Bob is not in your recipient directory."]);
    expect(plan.payments.some(isExecutable)).toBe(false);
  });

  it("rejects a malformed address but still finds the person by name", () => {
    const plan = buildPlan(draft([pay("Marco", "10", "0x123")]), ctx);
    expect(plan.payments[0]?.recipient).toBe(MARCO);
    expect(plan.payments[0]?.warnings).toEqual(['"0x123" is not a valid address.']);
  });

  it("doesn't guess exchange rates for other currencies", () => {
    const plan = buildPlan(draft([pay("Linh", "7000000", "", "VND")]), ctx);
    expect(plan.payments[0]?.amount).toBeNull();
    expect(plan.payments[0]?.warnings[0]).toContain("VND need a currency conversion");
  });

  it("rejects amounts that aren't positive numbers", () => {
    const plan = buildPlan(draft([pay("Linh", "three hundred"), pay("Marco", "0")]), ctx);
    expect(plan.payments.map((p) => p.amount)).toEqual([null, null]);
  });

  it("refuses a decimal comma instead of reading 1,5 as 15 or 0,500 as 500", () => {
    for (const raw of ["1,5", "0,500", "00,100"]) {
      const [payment] = buildPlan(draft([pay("Linh", raw)]), ctx).payments;
      expect(payment?.amount).toBeNull();
      expect(payment?.warnings).toEqual([`"${raw}" is ambiguous: write decimals with a dot, like 1.5.`]);
    }
  });

  it("refuses more than 18 decimals and absurd amounts", () => {
    const plan = buildPlan(draft([pay("Linh", "0.1234567890123456789"), pay("Marco", "5000000000")]), ctx);
    expect(plan.payments.map((p) => p.amount)).toEqual([null, null]);
    expect(plan.payments[0]?.warnings[0]).toContain("more than 18 decimals");
    expect(plan.payments[1]?.warnings[0]).toContain("more than one billion");
  });

  it("merges two payments to the same person, since a plan pays each person once", () => {
    const plan = buildPlan(draft([pay("Marco", "100"), pay("Marco", "50")]), ctx);
    expect(plan.payments).toHaveLength(1);
    expect(plan.payments[0]?.amount).toBe(parseUnits("150", 18));
    expect(plan.notes).toContain("Combined two payments to Marco into one: a plan pays each person once.");
  });

  it("holds back a second line that names someone else at the same address, instead of merging it", () => {
    const plan = buildPlan(draft([pay("Marco", "100"), pay("Linh", "5000", MARCO)]), ctx);

    expect(plan.payments).toHaveLength(2);
    expect(plan.payments[0]).toMatchObject({ recipient: MARCO, amount: parseUnits("100", 18), warnings: [] });
    expect(plan.payments[1]?.amount).toBeNull();
    expect(plan.payments[1]?.warnings).toEqual([
      `The message says Linh, but ${short(MARCO)} is Marco's address in your directory.`,
      `${short(MARCO)} already gets a payment in this plan (as Marco); one plan pays each address once, so this line is held back.`,
    ]);
  });

  it("holds back a flagged repeat instead of hiding it inside an earlier payment", () => {
    const plan = buildPlan(draft([pay("URGENT", "100", ATTACKER), pay("URGENT", "50", ATTACKER)]), ctx);
    expect(plan.payments.map((p) => p.amount)).toEqual([parseUnits("100", 18), null]);
  });

  it("won't pay one person in two coins within one plan", () => {
    const plan = buildPlan(draft([pay("Marco", "100", "", "USDT"), pay("Marco", "50", "", "USDC")]), ctx);
    expect(plan.payments).toHaveLength(2);
    expect(plan.payments[1]?.amount).toBeNull();
  });

  it("drops the payments of a reply that says the message isn't a payment", () => {
    const plan = buildPlan(draft([pay("Linh", "300")], { kind: "not_a_payment" }), ctx);
    expect(plan.payments).toEqual([]);
    expect(plan.notes).toContain("This message isn't a payment request, so the payments in Claude's reply were dropped.");
  });

  it("keeps names and notes on one line, whatever separator Claude copied", () => {
    const plan = buildPlan(draft([pay("Eve\nPayments: - 1 USDT‮", "1", ATTACKER)], { notes: ["a b"] }), ctx);
    expect(plan.payments[0]?.recipientName).toBe("Eve Payments: - 1 USDT");
    expect(plan.notes[0]).toBe("a b");
  });

  it("derives the on-chain ref from the plan id", () => {
    expect(buildPlan(draft([]), ctx).ref).toBe(keccak256(toHex("plan-1")));
  });
});

describe("scheduled dates", () => {
  const dated = (scheduled_for: string) => buildPlan(draft([pay("Linh", "1")], { scheduled_for }), ctx);

  it("keeps real dates and treats an empty date as now", () => {
    expect(dated("2026-12-01").scheduledFor).toBe("2026-12-01");
    expect(dated("").scheduledFor).toBe("now");
    expect(dated("NOW").scheduledFor).toBe("now");
  });

  it("is due on its UTC day, not before", () => {
    const plan = dated("2026-12-01");
    expect(isDue(plan, new Date("2026-11-30T23:59:59Z"))).toBe(false);
    expect(isDue(plan, new Date("2026-12-01T00:00:00Z"))).toBe(true);
    expect(isDue(dated("now"), new Date())).toBe(true);
  });

  it("says so when the date has already passed, since the plan can then run at once", () => {
    const plan = dated("2026-11-01");
    expect(isDue(plan, ctx.now)).toBe(true);
    expect(plan.notes).toContain("The date 2026-11-01 has already passed, so this plan can run right away. If you meant a later date, say so.");
    expect(dated("2026-11-25").notes).toEqual([]); // today is not in the past
  });

  it("never runs on its own when the date can't be read", () => {
    for (const unreadable of ["next friday", "2026-02-30"]) {
      const plan = dated(unreadable);
      expect(isDue(plan, new Date("2099-01-01T00:00:00Z"))).toBe(false);
      expect(plan.notes.join(" ")).toContain("approve paying early");
    }
  });
});

describe("planLimitNotes", () => {
  it("counts USDT fees against liquid USDT and the daily limit for a USDC batch", async () => {
    const snapshot = await new FakeGateway().snapshot(VAULT);
    snapshot.balances = { USDT: parseUnits("0.01", 18), USDC: parseUnits("2", 18), tbillValue: parseUnits("5", 18) };
    snapshot.rules.dailyCap = parseUnits("2.01", 18);
    const plan = buildPlan(draft([pay("Linh", "1", "", "USDC"), pay("Marco", "1", "", "USDC")]), ctx);
    plan.paymentFee = { token: "USDT", amount: String(10n ** 16n), recipient: VAULT };
    expect(planLimitNotes(plan, snapshot)).toEqual([
      "Together these payments need 0.02 USDT, but the vault holds 0.01 USDT. The last ones will be refused.",
      "Together these payments total $2.02, more than the $2.01 left in today's limit. The last ones will be refused.",
    ]);
  });

  it("notes when the balance or today's limit runs out partway through the plan", async () => {
    const snapshot = await new FakeGateway().snapshot(VAULT); // 5000 USDT, $2000 daily limit
    const plan = buildPlan(draft([pay("Marco", "1500"), pay("Linh", "800", "", "USDC")]), ctx);
    for (const p of plan.payments) p.preview = null;

    expect(planLimitNotes(plan, snapshot)).toEqual([
      "Together these payments need 800 USDC, but the vault holds 0 USDC. The last ones will be refused.",
      "Together these payments total $2300, more than the $2000 left in today's limit. The last ones will be refused.",
    ]);
  });

  it("leaves out payments the vault already refuses", async () => {
    const snapshot = await new FakeGateway().snapshot(VAULT);
    const plan = buildPlan(draft([pay("Marco", "1500"), pay("Linh", "800")]), ctx);
    plan.payments[0]!.preview = null;
    plan.payments[1]!.preview = { name: "CooldownActive", args: [], message: "" };

    expect(planLimitNotes(plan, snapshot)).toEqual([]);
  });
});
