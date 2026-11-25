import path from "node:path";
import { pad, parseUnits, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { Executor, VaultBusyError } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { buildPlan, type Plan } from "../src/plan/build";
import type { RecipientEntry } from "../src/plan/directory";
import { ATTACKER, FakeGateway, LINH, MARCO, OWNER, USDC, USDT, VAULT, refusal, tempDir } from "./fakes";

const directory: RecipientEntry[] = [
  { name: "Linh", address: LINH },
  { name: "Marco", address: MARCO },
];

function makePlan(id: string, payments: { name: string; address?: string; amount: string }[]): Plan {
  return buildPlan(
    {
      kind: "payment",
      scheduled_for: "now",
      notes: [],
      payments: payments.map((p) => ({ recipient_name: p.name, recipient_address: p.address ?? "", amount: p.amount, currency: "USD" })),
    },
    { id, owner: OWNER, vault: VAULT, message: "test", directory, now: new Date("2026-11-25T12:00:00Z") },
  );
}

let gateway: FakeGateway;
let journalFile: string;
let journal: Journal;
let executor: Executor;

beforeEach(() => {
  gateway = new FakeGateway();
  journalFile = path.join(tempDir(), "journal.jsonl");
  journal = new Journal(journalFile);
  executor = new Executor({ gateway, journal, tokenAddress: async (s) => (s === "USDC" ? USDC : USDT) });
});

describe("Executor", () => {
  it("pays each recipient once and journals every step", async () => {
    const plan = makePlan("p1", [
      { name: "Linh", amount: "300" },
      { name: "Marco", amount: "450" },
    ]);

    const results = await executor.execute(plan);

    expect(results.map((r) => r.status)).toEqual(["paid", "paid"]);
    expect(gateway.sent).toEqual([
      { recipient: LINH, token: USDT, amount: parseUnits("300", 18), ref: plan.ref },
      { recipient: MARCO, token: USDT, amount: parseUnits("450", 18), ref: plan.ref },
    ]);
    expect(journal.eventsFor("p1").map((e) => e.type)).toEqual([
      "step_sent",
      "step_succeeded",
      "step_sent",
      "step_succeeded",
      "plan_finished",
    ]);
  });

  it("keeps going when the vault refuses one payment (the attack demo)", async () => {
    gateway.refusals.set(ATTACKER, refusal("RecipientNotAllowed", [ATTACKER]));
    const plan = makePlan("p2", [
      { name: "URGENT", address: ATTACKER, amount: "5000" },
      { name: "Linh", amount: "300" },
    ]);

    const [attack, linh] = await executor.execute(plan);

    expect(attack).toMatchObject({ status: "refused", error: { name: "RecipientNotAllowed" } });
    expect(linh?.status).toBe("paid");
    expect(gateway.sent).toHaveLength(1);
    expect(journal.eventsFor("p2").some((e) => e.type === "step_refused")).toBe(true);
  });

  it("never sends twice when the same plan runs again", async () => {
    const plan = makePlan("p3", [{ name: "Linh", amount: "300" }]);
    await executor.execute(plan);

    const again = await executor.execute(plan);

    expect(gateway.sent).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: "paid", note: "Already paid in an earlier run." });
  });

  it("after a crash, confirms a broadcast payment from the chain instead of resending", async () => {
    const plan = makePlan("p4", [{ name: "Linh", amount: "300" }]);
    const hash = pad("0xabc", { size: 32 }) as Hex;
    journal.append({ type: "step_sent", planId: "p4", index: 0, hash }); // the server died right after sending
    gateway.receipts.set(hash, "success");

    const restarted = new Executor({ gateway, journal: new Journal(journalFile), tokenAddress: async () => USDT });
    const [result] = await restarted.execute(plan);

    expect(gateway.sent).toHaveLength(0);
    expect(result).toMatchObject({ status: "paid", hash, note: "Confirmed from an earlier run." });
  });

  it("resends when an earlier broadcast never reached the chain", async () => {
    const plan = makePlan("p5", [{ name: "Linh", amount: "300" }]);
    journal.append({ type: "step_sent", planId: "p5", index: 0, hash: pad("0xdead", { size: 32 }) as Hex }); // receipt unknown

    const [result] = await executor.execute(plan);

    expect(gateway.sent).toHaveLength(1);
    expect(result?.status).toBe("paid");
  });

  it("treats the vault's DuplicatePayment as proof the payment already went through", async () => {
    gateway.refusals.set(LINH, refusal("DuplicatePayment", ["0x01", LINH]));
    const plan = makePlan("p6", [{ name: "Linh", amount: "300" }]);

    const [result] = await executor.execute(plan);

    expect(result?.status).toBe("paid");
    expect(gateway.sent).toHaveLength(0);
  });

  it("skips payments that need the owner's attention", async () => {
    const plan = makePlan("p7", [{ name: "Bob", amount: "50" }]);

    const [result] = await executor.execute(plan);

    expect(result).toMatchObject({ status: "skipped", note: "Bob is not in your recipient directory." });
    expect(gateway.sent).toHaveLength(0);
  });

  it("runs one plan per vault at a time", async () => {
    let release = () => {};
    gateway.hold = new Promise<void>((resolve) => (release = resolve));
    const first = executor.execute(makePlan("p8", [{ name: "Linh", amount: "1" }]));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the first plan reach the chain

    await expect(executor.execute(makePlan("p9", [{ name: "Marco", amount: "1" }]))).rejects.toBeInstanceOf(VaultBusyError);

    release();
    await expect(first).resolves.toHaveLength(1);
    await expect(executor.execute(makePlan("p10", [{ name: "Marco", amount: "1" }]))).resolves.toHaveLength(1);
  });
});
