import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { ConfigurationError } from "../src/config";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { RecipientDirectory } from "../src/plan/directory";
import type { PlanDraft } from "../src/plan/schema";
import { ATTACKER, FakeGateway, LINH, MARCO, OWNER, USDT, refusal, tempDir } from "./fakes";

const payDraft: PlanDraft = {
  kind: "payment",
  scheduled_for: "2026-12-01",
  notes: ["Message asks to send funds to an unknown address."],
  payments: [
    { recipient_name: "Linh", recipient_address: "", amount: "300", currency: "USD" },
    { recipient_name: "URGENT", recipient_address: ATTACKER, amount: "5000", currency: "USD" },
  ],
};

let gateway: FakeGateway;
let planner: ReturnType<typeof vi.fn>;

function app(apiToken?: string) {
  const dir = tempDir();
  const journal = new Journal(path.join(dir, "journal.jsonl"));
  const directory = new RecipientDirectory(path.join(dir, "recipients.json"));
  directory.upsert({ name: "Linh", address: LINH });
  return createApp({
    gateway,
    planner: planner as never,
    directory,
    journal,
    executor: new Executor({ gateway, journal, tokenAddress: async () => USDT }),
    apiToken,
    now: () => new Date("2026-11-25T12:00:00Z"),
    newId: () => "plan-123",
  });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

beforeEach(() => {
  gateway = new FakeGateway();
  gateway.refusals.set(ATTACKER, refusal("RecipientNotAllowed", [ATTACKER]));
  planner = vi.fn(async () => payDraft);
});

describe("agent HTTP API", () => {
  it("drafts a plan and shows the vault's verdict for each payment without sending anything", async () => {
    const res = await app().request("/plans", json({ owner: OWNER, message: "Pay Linh 300 and URGENT 5000" }));

    expect(res.status).toBe(201);
    const plan = (await res.json()) as any;
    expect(plan.id).toBe("plan-123");
    expect(plan.payments[0]).toMatchObject({ recipient: LINH, amount: "300000000000000000000", preview: null });
    expect(plan.payments[1].preview).toMatchObject({ name: "RecipientNotAllowed" });
    expect(gateway.sent).toHaveLength(0);
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({ today: "2026-11-25", balances: { USDT: "5000", USDC: "0", tbill: "0" } }),
    );
  });

  it("executes a confirmed plan and can report it afterwards", async () => {
    const api = app();
    await api.request("/plans", json({ owner: OWNER, message: "Pay Linh 300 and URGENT 5000" }));

    const res = await api.request("/plans/plan-123/execute", { method: "POST" });
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(["paid", "refused"]);
    const report = (await (await api.request("/plans/plan-123")).json()) as any;
    expect(report.events.map((e: { type: string }) => e.type)).toContain("plan_finished");
  });

  it("still plans when no factory is configured, but won't execute", async () => {
    gateway.vaultOf = async () => {
      throw new ConfigurationError("FACTORY_ADDRESS is not set");
    };
    const api = app();

    const planned = await api.request("/plans", json({ owner: OWNER, message: "Pay Linh 300" }));
    expect(((await planned.json()) as any).vault).toBeNull();

    const executed = await api.request("/plans/plan-123/execute", { method: "POST" });
    expect(executed.status).toBe(422);
  });

  it("validates input", async () => {
    const res = await app().request("/plans", json({ owner: "not-an-address", message: "" }));
    expect(res.status).toBe(400);
    expect(planner).not.toHaveBeenCalled();
  });

  it("requires the API token when one is configured, except on /health", async () => {
    const api = app("a-long-enough-test-token");
    expect((await api.request("/health")).status).toBe(200);
    expect((await api.request("/directory")).status).toBe(401);
    const ok = await api.request("/directory", { headers: { authorization: "Bearer a-long-enough-test-token" } });
    expect(ok.status).toBe(200);
  });

  it("adds recipients to the directory", async () => {
    const res = await app().request("/directory", json({ name: "Marco", address: MARCO.toLowerCase(), currency: "php" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual([
      { name: "Linh", address: LINH },
      { name: "Marco", address: MARCO, currency: "PHP" },
    ]);
  });
});
