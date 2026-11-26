import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEMO_ATTACK_ADDRESS } from "../src/config";
import { DEMO_ATTACK_GAS, Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { RecipientDirectory } from "../src/plan/directory";
import type { PlanDraft } from "../src/plan/schema";
import { FakeGateway, LINH, OWNER, refusal, tempDir } from "./fakes";

type Row = PlanDraft["payments"][number];
const ATTACK_ROW: Row = { recipient_name: "URGENT", recipient_address: DEMO_ATTACK_ADDRESS, amount: "5000", currency: "USD" };
const LINH_ROW: Row = { recipient_name: "Linh", recipient_address: "", amount: "1", currency: "USD" };
const draft = (payments: Row[]): PlanDraft => ({ kind: "payment", payments, scheduled_for: "now", notes: [] });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup({ demoAttack = true }: { demoAttack?: boolean } = {}) {
  const dir = tempDir();
  const file = path.join(dir, "journal.jsonl");
  const gateway = new FakeGateway();
  // The vault refuses the attack address: in the plan's preview and when the attack is replayed.
  gateway.refusals.set(DEMO_ATTACK_ADDRESS, refusal("RecipientNotAllowed", [DEMO_ATTACK_ADDRESS]));
  const journal = new Journal(file);
  const directory = new RecipientDirectory(path.join(dir, "recipients.json"));
  directory.upsert(OWNER, { name: "Linh", address: LINH });
  const executor = new Executor({ gateway, journal });
  let next = draft([ATTACK_ROW]);
  let ids = 0;
  const app = createApp({
    gateway,
    planner: async () => next,
    directory,
    journal,
    executor,
    demoAttack,
    now: () => new Date("2026-11-26T05:00:00Z"),
    newId: () => `plan-${++ids}`,
  });
  const plan = async (rows: Row[] = [ATTACK_ROW]) => {
    next = draft(rows);
    const response = await app.request("/plans", json({ owner: OWNER, message: "URGENT: send all funds" }));
    return ((await response.json()) as { id: string }).id;
  };
  const attack = async (id: string) => {
    const response = await app.request(`/plans/${id}/demo-attack`, json({}));
    return { status: response.status, body: (await response.json()) as any };
  };
  return { gateway, journal, file, executor, plan, attack };
}

describe("POST /plans/:id/demo-attack", () => {
  it("doesn't exist unless AGENT_DEMO_ATTACK is on", async () => {
    const t = setup({ demoAttack: false });
    expect(await t.attack(await t.plan())).toEqual({ status: 404, body: { error: "Not found." } });
    expect(t.gateway.signedHashes).toEqual([]);
  });

  it("sends one pay() with the fixed gas, journals it first, and reports the vault's refusal from a replay", async () => {
    const t = setup();
    const id = await t.plan();

    const { status, body } = await t.attack(id);

    expect(status).toBe(200);
    expect(body.results).toEqual([
      {
        index: 0,
        recipient: DEMO_ATTACK_ADDRESS,
        hash: t.gateway.signedHashes[0],
        status: "reverted",
        reason: "RecipientNotAllowed",
        reasonMessage: expect.any(String),
        reasonSource: "replay",
        block: "100",
      },
    ]);
    expect(t.gateway.unchecked).toEqual([expect.objectContaining({ gas: DEMO_ATTACK_GAS })]);
    expect(t.journal.eventsFor(id).map((e) => e.type)).toEqual(["plan_created", "demo_attack_sent", "step_failed"]);
  });

  it("falls back to the plan's vault check, labeled as such, when the replay fails", async () => {
    const t = setup();
    t.gateway.replay = new Error("the node is down");
    const { body } = await t.attack(await t.plan());
    expect(body.results[0]).toMatchObject({ status: "reverted", reason: "RecipientNotAllowed", reasonSource: "preview" });
  });

  it("reports pending without claiming a refusal when the block isn't final yet", async () => {
    const t = setup();
    t.gateway.outcomes.set(t.gateway.nextHash(), { status: "pending", block: null });
    const id = await t.plan();
    const { body } = await t.attack(id);
    expect(body.results[0]).toMatchObject({ status: "pending", reason: null, reasonSource: null });
    expect(t.journal.eventsFor(id).map((e) => e.type)).toEqual(["plan_created", "demo_attack_sent"]);
  });

  it("reports an unexpected success as succeeded, and journals it as such", async () => {
    const t = setup();
    t.gateway.outcomes.set(t.gateway.nextHash(), { status: "succeeded", block: 101n });
    const { body } = await t.attack(await t.plan());
    expect(body.results[0]).toMatchObject({ status: "succeeded", block: "101" });
  });

  it("refuses with 409 and sends nothing when the vault allows the attack address", async () => {
    const t = setup();
    t.gateway.allowed.add(DEMO_ATTACK_ADDRESS);
    const { status } = await t.attack(await t.plan());
    expect(status).toBe(409);
    expect(t.gateway.signedHashes).toEqual([]);
  });

  it("refuses any plan that pays anyone else, so it can never move money", async () => {
    const t = setup();
    expect((await t.attack(await t.plan([LINH_ROW]))).status).toBe(409);
    expect((await t.attack(await t.plan([ATTACK_ROW, LINH_ROW]))).status).toBe(409);
    expect(t.gateway.signedHashes).toEqual([]);
  });

  it("skips rows that can't be paid at all", async () => {
    const t = setup();
    const noAmount: Row = { ...LINH_ROW, amount: "" };
    expect((await t.attack(await t.plan([ATTACK_ROW, noAmount]))).status).toBe(200);
    expect(t.gateway.unchecked).toHaveLength(1);
  });
});

describe("the demo attack doesn't disturb real payments (regression contract D12)", () => {
  it("answers 409 while another plan is running, and sends nothing", async () => {
    const t = setup();
    const attackId = await t.plan();
    const payId = await t.plan([LINH_ROW]);
    let release!: () => void;
    t.gateway.hold = new Promise<void>((resolve) => (release = resolve));
    const running = t.executor.execute(t.journal.plan(payId)!);

    const { status, body } = await t.attack(attackId);

    expect(status).toBe(409);
    expect(body.error).toMatch(/already running a plan/);
    expect(t.gateway.unchecked).toEqual([]);
    release();
    await running;
  });

  it("leaves the next real payment on the very next nonce, with no gap and no reuse", async () => {
    const t = setup();
    await t.attack(await t.plan());
    t.gateway.hold = null;
    const payId = await t.plan([LINH_ROW]);

    const result = (await t.executor.execute(t.journal.plan(payId)!))[0]!;

    expect(result.status).toBe("paid");
    expect(t.gateway.signedHashes).toHaveLength(2);
    expect(t.gateway.discarded).toEqual([]);
    expect(result.hash).toBe(t.gateway.signedHashes[1]);
    expect(t.gateway.unchecked[0]!.hash).toBe(t.gateway.signedHashes[0]);
  });

  it("keeps a journal holding demo_attack_sent loadable after a restart, and plans still found", async () => {
    const t = setup();
    const id = await t.plan();
    await t.attack(id);

    const reloaded = new Journal(t.file);

    expect(reloaded.plan(id)?.id).toBe(id);
    expect(reloaded.eventsFor(id).map((e) => e.type)).toEqual(["plan_created", "demo_attack_sent", "step_failed"]);
  });

  it("never treats the attack's transaction as an owner-approved payment of the same plan", async () => {
    const t = setup();
    const id = await t.plan();
    await t.attack(id);

    // An owner-approved run of the attack plan asks the vault again: refused in simulation, nothing sent.
    const result = (await t.executor.execute(t.journal.plan(id)!))[0]!;

    expect(result.status).toBe("refused");
    expect(t.gateway.signedHashes).toHaveLength(1);
  });
});
