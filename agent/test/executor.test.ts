import path from "node:path";
import { HttpRequestError, InsufficientFundsError, pad, parseUnits, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBusyError, Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { buildPlan, type Plan } from "../src/plan/build";
import type { RecipientEntry } from "../src/plan/directory";
import { ATTACKER, FakeGateway, LINH, MARCO, OWNER, USDT, VAULT, refusal, tempDir } from "./fakes";

const OTHER_VAULT = MARCO; // any second address will do as another owner's vault

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

const hashOf = (n: number) => pad(`0x${n.toString(16)}`, { size: 32 }) as Hex;

let gateway: FakeGateway;
let journalFile: string;
let journal: Journal;
let executor: Executor;
const types = (planId: string) => journal.eventsFor(planId).map((e) => e.type);

beforeEach(() => {
  gateway = new FakeGateway();
  journalFile = path.join(tempDir(), "journal.jsonl");
  journal = new Journal(journalFile);
  executor = new Executor({ gateway, journal });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Executor: a first run", () => {
  it("pays each recipient once, journaling each hash before it is sent", async () => {
    const plan = makePlan("p1", [
      { name: "Linh", amount: "300" },
      { name: "Marco", amount: "450" },
    ]);

    const results = await executor.execute(plan);

    expect(results.map((r) => r.status)).toEqual(["paid", "paid"]);
    // Same 18-decimal base units as plan responses.
    expect(results.map((r) => r.amount)).toEqual(["300000000000000000000", "450000000000000000000"]);
    expect(gateway.sent).toEqual([
      { recipient: LINH, token: USDT, amount: parseUnits("300", 18), ref: plan.ref },
      { recipient: MARCO, token: USDT, amount: parseUnits("450", 18), ref: plan.ref },
    ]);
    expect(types("p1")).toEqual(["step_sent", "step_succeeded", "step_sent", "step_succeeded", "plan_finished"]);
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
    expect(types("p2")).toContain("step_refused");
  });

  it("treats the vault's DuplicatePayment as proof the payment already went through", async () => {
    gateway.refusals.set(LINH, refusal("DuplicatePayment", ["0x01", LINH]));

    const [result] = await executor.execute(makePlan("p6", [{ name: "Linh", amount: "300" }]));

    expect(result?.status).toBe("paid");
    expect(gateway.sent).toHaveLength(0);
  });

  it("counts a DuplicatePayment only once the finalized block shows it too", async () => {
    gateway.refusals.set(LINH, refusal("DuplicatePayment", ["0x01", LINH]));
    gateway.duplicateIsFinal = false; // the earlier payment is in a block that could still be undone
    const plan = makePlan("p6b", [{ name: "Linh", amount: "300" }]);

    const [first] = await executor.execute(plan);
    expect(first).toMatchObject({ status: "pending", hash: null });
    expect(types("p6b")).not.toContain("step_succeeded");

    gateway.duplicateIsFinal = true;
    const [second] = await executor.execute(plan);
    expect(second?.status).toBe("paid");
    expect(gateway.sent).toHaveLength(0);
  });

  it("gives the nonce back when the signed payment can't be journaled, and sends nothing", async () => {
    const append = journal.append.bind(journal);
    journal.append = ((event: Parameters<Journal["append"]>[0]) => {
      if (event.type === "step_sent") throw new Error("ENOSPC: no space left on device");
      return append(event);
    }) as Journal["append"];

    await expect(executor.execute(makePlan("j1", [{ name: "Linh", amount: "1" }]))).rejects.toThrow("ENOSPC");

    expect(gateway.discarded).toEqual([hashOf(1)]);
    expect(gateway.sent).toHaveLength(0);
  });

  it("doesn't call a reverted send 'failed' when the vault already counts the payment as made", async () => {
    gateway.settles.set(hashOf(1), { status: "not_paid", hash: hashOf(1), reason: "The transaction reverted on-chain." });
    gateway.previewPay = async () => refusal("DuplicatePayment", ["0x01", LINH]); // an earlier transaction paid Linh

    const [result] = await executor.execute(makePlan("d2", [{ name: "Linh", amount: "1" }]));

    expect(result).toMatchObject({ status: "pending", hash: null }); // the earlier payment isn't final yet
    gateway.paidAsOfFinality = async () => true;
    const [again] = await executor.execute(makePlan("d2", [{ name: "Linh", amount: "1" }]));
    expect(again?.status).toBe("paid");
    expect(types("d2")).toEqual(["step_sent", "step_failed", "step_succeeded", "plan_finished"]);
  });

  it("records a payment that another transaction replaced under its own hash", async () => {
    gateway.settles.set(hashOf(1), { status: "not_paid", hash: hashOf(1), replacedBy: hashOf(0xee), reason: "replaced" });

    const [result] = await executor.execute(makePlan("x1", [{ name: "Linh", amount: "1" }]));

    expect(result).toMatchObject({ status: "failed", hash: hashOf(1) });
    expect(journal.eventsFor("x1").find((e) => e.type === "step_failed")).toMatchObject({ hash: hashOf(1), replacedBy: hashOf(0xee) });
  });

  it("skips payments that need the owner's attention", async () => {
    const [result] = await executor.execute(makePlan("p7", [{ name: "Bob", amount: "50" }]));

    expect(result).toMatchObject({ status: "skipped", note: "Bob is not in your recipient directory." });
    expect(gateway.sent).toHaveLength(0);
  });

  it("reports a signing failure as failed, without leaking the RPC URL, and pays the others", async () => {
    const sign = gateway.signPay.bind(gateway);
    gateway.signPay = async (vault, step) => {
      if (step.recipient === LINH) {
        throw new HttpRequestError({ url: "https://bsc-testnet.example/v1/SECRETKEY", body: {}, details: "boom" });
      }
      return sign(vault, step);
    };

    const results = await executor.execute(makePlan("f1", [{ name: "Linh", amount: "1" }, { name: "Marco", amount: "1" }]));

    expect(results.map((r) => r.status)).toEqual(["failed", "paid"]);
    expect(types("f1")[0]).toBe("step_failed");
    expect(JSON.stringify(results)).not.toContain("SECRETKEY");
    expect(JSON.stringify(journal.eventsFor("f1"))).not.toContain("SECRETKEY");
  });

  it("says plainly when the agent wallet has no gas money", async () => {
    gateway.signPay = async () => {
      throw new InsufficientFundsError();
    };

    const [result] = await executor.execute(makePlan("g1", [{ name: "Linh", amount: "1" }]));

    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("no test BNB") });
  });

  it("fails a payment whose transaction reverted on-chain", async () => {
    gateway.settles.set(hashOf(1), { status: "not_paid", hash: hashOf(1), reason: "The transaction reverted on-chain." });

    const [result] = await executor.execute(makePlan("r1", [{ name: "Linh", amount: "1" }]));

    expect(result).toMatchObject({ status: "failed", hash: hashOf(1) });
    expect(types("r1")).toEqual(["step_sent", "step_failed", "plan_finished"]);
  });

  it("marks a slow payment pending and still pays the rest", async () => {
    gateway.settles.set(hashOf(1), { status: "pending" }); // Linh's transaction isn't final within the wait

    const results = await executor.execute(makePlan("t1", [{ name: "Linh", amount: "1" }, { name: "Marco", amount: "1" }]));

    expect(results.map((r) => r.status)).toEqual(["pending", "paid"]);
    expect(types("t1")).not.toContain("plan_finished"); // not every payment is settled yet
  });

  it("keeps the hash when the broadcast fails, then settles it on the next run", async () => {
    gateway.broadcastError = new Error("the node didn't answer");
    const plan = makePlan("b1", [{ name: "Linh", amount: "1" }]);

    const [first] = await executor.execute(plan);
    expect(first).toMatchObject({ status: "pending", hash: hashOf(1) });
    expect(types("b1")).toEqual(["step_sent"]);

    const [second] = await executor.execute(plan); // never reached the chain: "unknown", so it is sent again
    expect(second?.status).toBe("paid");
    expect(gateway.sent).toHaveLength(1);
  });

  it("doesn't resend when a lost reply hid a broadcast that did land", async () => {
    gateway.broadcastError = new Error("connection reset after sending");
    gateway.broadcastLanded = true;
    const plan = makePlan("b2", [{ name: "Linh", amount: "1" }]);

    await executor.execute(plan);
    const [again] = await executor.execute(plan);

    expect(again).toMatchObject({ status: "paid", hash: hashOf(1), note: "Confirmed from an earlier run." });
    expect(gateway.sent).toHaveLength(1);
  });
});

describe("Executor: running a plan again", () => {
  it("records a V2 duplicate only after locating its matching finalized receipt with the signed fee terms", async () => {
    const plan = makePlan("fee-duplicate", [{ name: "Linh", amount: "1" }]);
    plan.paymentFee = { token: "USDT", amount: "10000000000000000", recipient: MARCO };
    gateway.refusals.set(LINH, refusal("DuplicatePayment", [plan.ref, LINH]));
    gateway.findFinalizedPayment = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(hashOf(42));
    const [unverified] = await executor.execute(plan);
    expect(unverified).toMatchObject({ status: "pending", hash: null });
    expect(types(plan.id)).not.toContain("step_succeeded");
    const [verified] = await executor.execute(plan);
    expect(verified).toMatchObject({ status: "paid", hash: hashOf(42) });
    expect(gateway.findFinalizedPayment).toHaveBeenCalledWith(VAULT, expect.objectContaining({
      fee: { token: USDT, amount: 10n ** 16n, treasury: MARCO },
    }));
    expect(gateway.sent).toHaveLength(0);
  });

  it("rechecks an old hashless V2 success without broadcasting when its receipt cannot be verified", async () => {
    const plan = makePlan("old-fee-duplicate", [{ name: "Linh", amount: "1" }]);
    plan.paymentFee = { token: "USDT", amount: "10000000000000000", recipient: MARCO };
    journal.append({ type: "step_succeeded", planId: plan.id, index: 0, hash: null });
    gateway.findFinalizedPayment = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
    const [result] = await executor.execute(plan);
    expect(result).toMatchObject({ status: "pending", hash: null });
    expect(gateway.sent).toHaveLength(0);
  });

  it("never sends twice when the same plan runs again", async () => {
    const plan = makePlan("p3", [{ name: "Linh", amount: "300" }]);
    await executor.execute(plan);

    const [again] = await executor.execute(plan);

    expect(gateway.sent).toHaveLength(1);
    expect(again).toMatchObject({ status: "paid", note: "Already paid in an earlier run." });
  });

  it("after a crash, confirms a sent payment from the chain instead of resending", async () => {
    const plan = makePlan("p4", [{ name: "Linh", amount: "300" }]);
    const hash = hashOf(0xabc);
    journal.append({ type: "step_sent", planId: "p4", index: 0, hash }); // the server died right after sending
    gateway.chain.set(hash, { status: "paid", hash });

    const restarted = new Executor({ gateway, journal: new Journal(journalFile) });
    const [result] = await restarted.execute(plan);

    expect(gateway.sent).toHaveLength(0);
    expect(result).toMatchObject({ status: "paid", hash, note: "Confirmed from an earlier run." });
  });

  it("waits for an earlier transaction that is still pending instead of resending", async () => {
    const hash = hashOf(0xabc);
    journal.append({ type: "step_sent", planId: "w1", index: 0, hash });
    gateway.chain.set(hash, { status: "pending" });
    gateway.settles.set(hash, { status: "paid", hash });

    const [result] = await executor.execute(makePlan("w1", [{ name: "Linh", amount: "1" }]));

    expect(gateway.sent).toHaveLength(0);
    expect(result).toMatchObject({ status: "paid", hash });
  });

  it("stays pending, without resending, while the earlier transaction isn't final", async () => {
    const hash = hashOf(0xabc);
    journal.append({ type: "step_sent", planId: "w2", index: 0, hash });
    gateway.chain.set(hash, { status: "pending" });

    const [result] = await executor.execute(makePlan("w2", [{ name: "Linh", amount: "1" }]));

    expect(result).toMatchObject({ status: "pending", hash });
    expect(gateway.sent).toHaveLength(0);
  });

  it("never resends while the earlier transaction can't be checked", async () => {
    journal.append({ type: "step_sent", planId: "w3", index: 0, hash: hashOf(0xabc) });
    gateway.checkPayment = async () => {
      throw new Error("RPC down");
    };

    const [result] = await executor.execute(makePlan("w3", [{ name: "Linh", amount: "1" }]));

    expect(result?.status).toBe("pending");
    expect(gateway.sent).toHaveLength(0);
  });

  it("sends again after an earlier transaction reverted", async () => {
    const hash = hashOf(0xabc);
    journal.append({ type: "step_sent", planId: "v1", index: 0, hash });
    gateway.chain.set(hash, { status: "not_paid", hash, reason: "The transaction reverted on-chain." });

    const [result] = await executor.execute(makePlan("v1", [{ name: "Linh", amount: "1" }]));

    expect(gateway.sent).toHaveLength(1);
    expect(result?.status).toBe("paid");
    expect(types("v1")).toEqual(["step_sent", "step_failed", "step_sent", "step_succeeded", "plan_finished"]);
  });

  it("waits on any earlier transaction that could still land, not just the newest", async () => {
    journal.append({ type: "step_sent", planId: "o1", index: 0, hash: hashOf(0xa1) });
    journal.append({ type: "step_sent", planId: "o1", index: 0, hash: hashOf(0xa2) });
    gateway.chain.set(hashOf(0xa1), { status: "pending" }); // older, still alive; the newer one never arrived

    const [result] = await executor.execute(makePlan("o1", [{ name: "Linh", amount: "1" }]));

    expect(result).toMatchObject({ status: "pending", hash: hashOf(0xa1) });
    expect(gateway.sent).toHaveLength(0);
  });

  it("sends again when an earlier broadcast never reached the chain", async () => {
    journal.append({ type: "step_sent", planId: "p5", index: 0, hash: hashOf(0xdead) }); // the chain doesn't know it

    const [result] = await executor.execute(makePlan("p5", [{ name: "Linh", amount: "300" }]));

    expect(gateway.sent).toHaveLength(1);
    expect(result?.status).toBe("paid");
  });

  it("pays a recipient the vault refused earlier once the vault allows it", async () => {
    gateway.refusals.set(LINH, refusal("CooldownActive", [LINH, 0n]));
    const plan = makePlan("c1", [{ name: "Linh", amount: "1" }]);
    await executor.execute(plan);
    gateway.refusals.delete(LINH);

    const [result] = await executor.execute(plan);

    expect(gateway.sent).toHaveLength(1);
    expect(result?.status).toBe("paid");
  });

  it("after a failure before sending, lets the vault prove the payment already happened", async () => {
    journal.append({ type: "step_failed", planId: "d1", index: 0, hash: null, error: "timeout" });
    gateway.refusals.set(LINH, refusal("DuplicatePayment", ["0x01", LINH]));

    const [result] = await executor.execute(makePlan("d1", [{ name: "Linh", amount: "1" }]));

    expect(gateway.sent).toHaveLength(0);
    expect(result?.status).toBe("paid");
  });
});

describe("Executor: guards", () => {
  it("runs one plan at a time, even for different vaults, since the agent has one key", async () => {
    let release = () => {};
    gateway.hold = new Promise<void>((resolve) => (release = resolve));
    const first = executor.execute(makePlan("p8", [{ name: "Linh", amount: "1" }]));
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the first plan reach the chain

    await expect(executor.execute(makePlan("p9", [{ name: "Marco", amount: "1" }]))).rejects.toBeInstanceOf(AgentBusyError);
    const elsewhere = { ...makePlan("p9b", [{ name: "Marco", amount: "1" }]), vault: OTHER_VAULT };
    await expect(executor.execute(elsewhere)).rejects.toBeInstanceOf(AgentBusyError);

    release();
    await expect(first).resolves.toHaveLength(1);
    await expect(executor.execute(makePlan("p10", [{ name: "Marco", amount: "1" }]))).resolves.toHaveLength(1);
  });

  it("frees the one-plan lock when a run fails partway, so the next run can start", async () => {
    const deployment = gateway.deployment.bind(gateway);
    gateway.deployment = vi.fn().mockRejectedValueOnce(new Error("RPC down")).mockImplementation(deployment);

    await expect(executor.execute(makePlan("e1", [{ name: "Linh", amount: "1" }]))).rejects.toThrow("RPC down");
    await expect(executor.execute(makePlan("e2", [{ name: "Linh", amount: "1" }]))).resolves.toHaveLength(1);
  });
});
