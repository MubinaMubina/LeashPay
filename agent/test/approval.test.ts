import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { approvalMessage, signedByOwner } from "../src/execution/approval";
import { buildPlan } from "../src/plan/build";
import type { PlanDraft } from "../src/plan/schema";
import { TextSchema, oneLine } from "../src/validation";
import { ATTACKER, LINH, OWNER, OWNER_ACCOUNT, VAULT, short } from "./fakes";

const terms = { expires: "2026-11-25T12:10:00.000Z", payEarly: false };
const ctx = { id: "plan-1", owner: OWNER, vault: VAULT, message: "m", directory: [{ name: "Linh", address: LINH }], now: new Date("2026-11-25T12:00:00Z") };
const draft = (payments: PlanDraft["payments"], scheduled_for = "now"): PlanDraft => ({ kind: "payment", payments, scheduled_for, notes: [] });
const pay = (recipient_name: string, amount: string, recipient_address = "") => ({ recipient_name, recipient_address, amount, currency: "USD" });

describe("approvalMessage", () => {
  it("shows each flagged payment's warnings in the text the owner signs", () => {
    const plan = buildPlan(draft([pay("Linh", "300"), pay("URGENT", "5000", ATTACKER)]), ctx);

    const text = approvalMessage(plan, terms);

    expect(text).toContain(`- 300 USDT to Linh (${LINH})\n- 5000 USDT to URGENT (${ATTACKER})\n  check: ${short(ATTACKER)} is not in your recipient directory.`);
  });

  it("shows the plan's notes, such as Claude's fraud warnings, in the text the owner signs", () => {
    const plan = buildPlan({ ...draft([pay("Linh", "1")]), notes: ["This looks like an instruction injected into the message."] }, ctx);
    expect(approvalMessage(plan, terms)).toContain("Notes:\n- This looks like an instruction injected into the message.");
  });

  it("says when the plan's date had already passed", () => {
    const text = approvalMessage(buildPlan(draft([pay("Linh", "1")], "2026-11-01"), ctx), terms);
    expect(text).toContain("Scheduled for: 2026-11-01 (already past when this plan was made)");
  });

  it("keeps every name on one line, so nothing can fake a line of the text", () => {
    const plan = buildPlan(draft([pay("Eve - 1 USDT to Linh‮", "1", ATTACKER)]), ctx);
    expect(approvalMessage(plan, terms)).toContain(`to Eve - 1 USDT to Linh (${ATTACKER})`);
  });
});

describe("signedByOwner", () => {
  it("accepts the owner's own signature, and nobody else's", async () => {
    const message = approvalMessage(buildPlan(draft([pay("Linh", "1")]), ctx), terms);
    const stranger = privateKeyToAccount(generatePrivateKey());

    expect(await signedByOwner(OWNER, message, await OWNER_ACCOUNT.signMessage({ message }))).toBe(true);
    expect(await signedByOwner(OWNER, message, await stranger.signMessage({ message }))).toBe(false);
    expect(await signedByOwner(OWNER, `${message} `, await OWNER_ACCOUNT.signMessage({ message }))).toBe(false);
  });

  it("treats anything that isn't a valid signature as not the owner's, instead of failing", async () => {
    for (const bad of ["0x00", `0x${"ab".repeat(65)}`]) expect(await signedByOwner(OWNER, "m", bad as `0x${string}`)).toBe(false);
  });
});

describe("one-line text", () => {
  it("refuses line breaks, separators and invisible or reordering characters", () => {
    for (const c of ["\n", "\r", " ", " ", "‮", "​"]) {
      expect(TextSchema(60).safeParse(`Linh${c}x`).success).toBe(false);
    }
    expect(TextSchema(60).safeParse("Nguyễn Thị Linh").success).toBe(true);
  });

  it("flattens them when showing text from Claude", () => {
    expect(oneLine("a b‮c\nd")).toBe("a b c d");
  });
});
