import path from "node:path";
import { keccak256, toHex, verifyTypedData, zeroAddress, type Address, type Hex, type TypedData } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { DEMO_ATTACK_ADDRESS, loadConfig } from "../src/config";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { buildPlan } from "../src/plan/build";
import { RecipientDirectory } from "../src/plan/directory";
import { type SponsorExecute, type SponsorTypedData } from "../src/sponsor/authorization";
import { SponsorshipService, type SponsorChain } from "../src/sponsor/service";
import { AGENT, FakeGateway, LINH, MARCO, OWNER, OWNER_ACCOUNT, STRANGER_ACCOUNT, VAULT, tempDir } from "./fakes";

const FACTORY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const ACTIVATION = { action: "activate", owner: OWNER } as const;
const ADD = { action: "addRecipient", owner: OWNER, recipient: LINH, monthlyCap: "150000000000000000000" } as const;

function setup() {
  const dir = tempDir();
  const gateway = new FakeGateway();
  const journal = new Journal(path.join(dir, "journal.jsonl"));
  const base = { gateway, journal, executor: new Executor({ gateway, journal }), directory: new RecipientDirectory(path.join(dir, "recipients.json")), planner: vi.fn() };
  const state = { now: 1_800_000_000n, vault: null as Address | null, nonce: 0n, allowed: false, cap: 0n, maxCost: 100n };
  const signed = new Map<Hex, SponsorExecute>();
  const chain = {
    factory: FACTORY, relayer: AGENT,
    checkedTime: vi.fn(async () => state.now),
    vaultOf: vi.fn(async () => state.vault),
    recipient: vi.fn(async () => ({ owner: OWNER, agent: AGENT, nonce: state.nonce, allowed: state.allowed, monthlyCap: state.cap })),
    verify: vi.fn(async (owner: Address, data: SponsorTypedData, signature: Hex) => verifyTypedData<TypedData, string>({ ...data, address: owner, signature })),
    quote: vi.fn(async (request: SponsorExecute) => ({ maxCost: state.maxCost, sign: async () => {
      const raw = toHex(String(signed.size + 1));
      signed.set(raw, request);
      return raw;
    } })),
    discardNonce: vi.fn(),
    submit: vi.fn(async (raw: Hex) => {
      const request = signed.get(raw)!;
      if (request.action === "activate") state.vault = VAULT;
      else { state.allowed = true; state.cap = request.monthlyCap; state.nonce = request.nonce + 1n; }
      return { hash: keccak256(raw), block: 100n };
    }),
  } satisfies SponsorChain;
  const open = (sponsor = true) => createApp({ ...base, sponsor: sponsor ? new SponsorshipService(chain, path.join(dir, "sponsorships.json")) : undefined });
  let api = open();
  const post = (path: string, body: unknown) => api.request(`/sponsor/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  async function approval(body: typeof ACTIVATION | typeof ADD = ACTIVATION) {
    const res = await post("prepare", body);
    expect(res.status).toBe(200);
    const { typedData, deadline, nonce } = await res.json() as { typedData: SponsorTypedData; deadline: string; nonce?: string };
    expect(typeof deadline).toBe("string");
    const signature = await OWNER_ACCOUNT.signTypedData<TypedData, string>(typedData);
    return { ...body, deadline, ...(nonce === undefined ? {} : { nonce }), signature };
  }
  return { state, chain, signed, post, approval, gateway, executor: base.executor, restart: (enable = true) => { api = open(enable); } };
}

describe("sponsored owner actions", () => {
  it("signs activation for the configured factory on chain 97 and reconciles a completed retry", async () => {
    const { post, approval, signed, state } = setup();
    const data = await (await post("prepare", ACTIVATION)).json() as { typedData: SponsorTypedData; deadline: string };
    expect(data.typedData).toMatchObject({ domain: { name: "LeashPay", version: "2", chainId: 97, verifyingContract: FACTORY }, primaryType: "ActivateVault", message: { owner: OWNER, deadline: data.deadline, rulesHash: "0x52d129d398847c5caf7a9ec999de0156e764c966103b1c9bb5450455f5536070" } });
    const body = await approval();
    const executed = await post("execute", body);
    expect(executed.status).toBe(200);
    expect(await executed.json()).toEqual({ vault: VAULT, hash: keccak256(toHex("1")) });
    expect(await (await post("execute", body)).json()).toEqual({ vault: VAULT });
    state.now = BigInt(body.deadline) + 3600n;
    expect(await (await post("execute", body)).json()).toEqual({ vault: VAULT });
    expect(signed.size).toBe(1);
  });

  it("binds a recipient approval to its vault, nonce, address, exact positive cap and deadline", async () => {
    const { post, approval, state, signed } = setup();
    expect((await post("prepare", ADD)).status).toBe(409);
    state.vault = VAULT;
    const data = await (await post("prepare", ADD)).json() as { typedData: SponsorTypedData; deadline: string; nonce: string };
    expect(data.typedData).toMatchObject({ domain: { verifyingContract: VAULT }, primaryType: "AddRecipient", message: { recipient: LINH, nonce: "0", monthlyCap: ADD.monthlyCap, deadline: data.deadline } });
    const body = await approval(ADD);
    for (const change of [{ recipient: MARCO }, { monthlyCap: "1" }, { nonce: "1" }, { deadline: String(BigInt(body.deadline) - 1n) }, { signature: await STRANGER_ACCOUNT.signTypedData<TypedData, string>(data.typedData) }]) {
      expect((await post("execute", { ...body, ...change })).status).toBe(403);
    }
    expect(signed.size).toBe(0);
    expect((await post("execute", body)).status).toBe(200);
    expect((await post("execute", body)).status).toBe(200);
    expect(signed.size).toBe(1);
    state.cap = 7n;
    expect((await post("execute", body)).status).toBe(409);
    state.allowed = false;
    expect((await post("execute", body)).status).toBe(409);
    state.now = BigInt(body.deadline) + 1n;
    expect((await post("execute", body)).status).toBe(409);
    expect(signed.size).toBe(1);
  });

  it("rejects arbitrary calls, target overrides, a malformed cap, and reserved recipients", async () => {
    const { post, state, signed } = setup();
    state.vault = VAULT;
    for (const field of [{ call: "0x" }, { to: LINH }, { value: "1" }, { rules: {} }, { factory: FACTORY }, { chainId: 97 }, { action: "withdraw" }]) {
      expect((await post("prepare", { ...ACTIVATION, ...field })).status).toBe(400);
    }
    for (const cap of [0, "0", "1.5", "-20", "0x01", "1".repeat(79), String(10n ** 27n + 1n)]) {
      expect((await post("prepare", { ...ADD, monthlyCap: cap })).status).toBe(400);
    }
    for (const recipient of [zeroAddress, OWNER, VAULT, AGENT, DEMO_ATTACK_ADDRESS]) {
      expect((await post("prepare", { ...ADD, recipient })).status).toBe(400);
    }
    expect(signed.size).toBe(0);
  });

  it("persists the signed transaction before broadcast and reuses it after restart, even with a new deadline", async () => {
    const { post, state, chain, signed, approval, restart } = setup();
    chain.submit.mockRejectedValueOnce(new Error("lost response"));
    const first = await post("execute", await approval());
    expect(first.ok).toBe(false);
    restart();
    state.now += 3n;
    expect((await post("execute", await approval())).status).toBe(200);
    expect(signed.size).toBe(1);
    expect(chain.submit.mock.calls[0]?.[0]).toBe(chain.submit.mock.calls[1]?.[0]);
  });

  it("shares the signer lock with payroll and never signs twice for a concurrent submission", async () => {
    const { chain, signed, approval, post, gateway, executor } = setup();
    const plan = buildPlan({
      kind: "payment", scheduled_for: "now", notes: [],
      payments: [{ recipient_name: "Linh", recipient_address: LINH, amount: "1", currency: "USDT" }],
    }, { id: "parallel", owner: OWNER, vault: VAULT, message: "Pay Linh 1", directory: [{ name: "Linh", address: LINH }], now: new Date() });
    const body = await approval();
    let finish = () => {};
    gateway.hold = new Promise<void>(resolve => { finish = resolve; });
    const payroll = executor.execute(plan);
    expect((await post("execute", body)).status).toBe(409);
    expect(signed.size).toBe(0);
    finish();
    await payroll;

    let started = () => {};
    const submitting = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const submit = chain.submit.getMockImplementation()!;
    chain.submit.mockImplementationOnce(async raw => { started(); await hold; return submit(raw); });
    const first = post("execute", body);
    await submitting;
    expect((await post("execute", body)).status).toBe(409);
    await expect(executor.execute(plan)).rejects.toThrow(/sponsor/);
    await expect(executor.demoAttack(plan, LINH)).rejects.toThrow(/sponsor/);
    finish();
    expect((await first).status).toBe(200);
    expect((await post("execute", body)).status).toBe(200);
    expect(signed.size).toBe(1);
  });

  it("keeps the per-wallet attempt limit across restarts even when the gas price is zero", async () => {
    const { state, signed, post, approval, restart } = setup();
    state.maxCost = 0n;
    expect((await post("execute", await approval())).status).toBe(200);
    for (let i = 1; i <= 10; i++) {
      state.allowed = false; state.nonce = 0n;
      const recipient = ("0x" + String(100 + i).padStart(40, "0")) as Address;
      const res = await post("execute", await approval({ ...ADD, recipient }));
      expect(res.status).toBe(i < 10 ? 200 : 429);
      restart();
    }
    expect(signed.size).toBe(10);
  });

  it("refuses to broadcast above the persistent daily budget", async () => {
    const { state, post, approval, signed, restart } = setup();
    state.maxCost = 5n * 10n ** 16n;
    expect((await post("execute", await approval())).status).toBe(200);
    restart();
    expect((await post("execute", await approval(ADD))).status).toBe(429);
    expect(signed.size).toBe(1);
    state.now += 86400n;
    expect((await post("execute", await approval(ADD))).status).toBe(200);
  });

  it("keeps sponsored routes opt-in and rejects a substituted factory in configuration", async () => {
    const { restart, post } = setup();
    restart(false);
    expect((await post("prepare", ACTIVATION)).status).toBe(503);
    expect(() => loadConfig({ FACTORY_ADDRESS: FACTORY, SPONSORED_FACTORY_ADDRESS: VAULT })).toThrow(/SPONSORED_FACTORY_ADDRESS/);
  });
});
