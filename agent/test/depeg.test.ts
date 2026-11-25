import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { COURNOT_ORIGIN, DEPEG_QUESTION, readDepeg, sourcesIn, type DepegReading } from "../src/depeg/cournot";
import { chooseToken, createDepegGuard, type DepegGuard } from "../src/depeg/guard";
import { approvalMessage } from "../src/execution/approval";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { RecipientDirectory } from "../src/plan/directory";
import type { PlanDraft } from "../src/plan/schema";
import { FakeGateway, LINH, MARCO, OWNER, tempDir } from "./fakes";

const MARKET = {
  id: 4242,
  title: "USDC depeg by December 31?",
  market_outcome: "YES",
  description: "Resolves YES if USDC trades below 98 cents for a 24-hour period before the end of 2026.",
  end_time: "2027-01-01T05:00:00Z",
};
const NOW = new Date("2026-11-26T06:30:00Z");

function cournot(over: { resolve?: unknown; probability?: unknown; status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (over.status) return new Response("{}", { status: over.status });
    const isResolve = String(url).endsWith("/resolve");
    const body = isResolve
      ? (over.resolve ?? { code: 0, data: { markets: [{ market_info: MARKET }, { market_info: { ...MARKET, id: 7, title: "USDT depeg?" } }] } })
      : (over.probability ?? {
          code: 0,
          data: {
            probability: 0.032,
            basis: [
              { source: "Polymarket", url: "https://polymarket.com/event/usdc-depeg", time: "2026-11-26T00:00:00Z" },
              { source: "Kalshi", url: "javascript:alert(1)" },
            ],
          },
        });
    return new Response(JSON.stringify(body), { status: 200, headers: over.headers ?? {} });
  });
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}

describe("readDepeg (Cournot)", () => {
  it("resolves the USDC depeg market, then reads its probability and sources", async () => {
    const c = cournot({ headers: { "x-request-id": "req-123" } });
    const reading = await readDepeg({ fetch: c.fetch, apiKey: "key", now: () => NOW });

    expect(reading).toEqual({
      claim: DEPEG_QUESTION,
      marketId: "4242",
      marketTitle: "USDC depeg by December 31?",
      probability: 0.032,
      sources: [
        { title: "Polymarket", url: "https://polymarket.com/event/usdc-depeg", time: "2026-11-26T00:00:00.000Z" },
        { title: "Kalshi" },
      ],
      fetchedAt: NOW.toISOString(),
      requestId: "req-123",
    });
    expect(c.calls.map((call) => call.url)).toEqual([`${COURNOT_ORIGIN}/intelligence/v1/resolve`, `${COURNOT_ORIGIN}/intelligence/v1/probability`]);
    expect(c.calls[1]!.body).toEqual({ message: DEPEG_QUESTION, market_ids: ["4242"] });
    expect(c.calls[1]!.headers["cournot-api-key"]).toBe("key");
  });

  it("reads a richer assessment's point estimate and nested basis", async () => {
    const c = cournot({ probability: { code: 0, data: { probability: { result: { point_estimate: "0.1" }, basis: { anchor: { source: "Pyth" } } } } } });
    expect(await readDepeg({ fetch: c.fetch, now: () => NOW })).toMatchObject({ probability: 0.1, sources: [{ title: "Pyth" }] });
  });

  const refusals: [string, Parameters<typeof cournot>[0], RegExp][] = [
    ["no matching market", { resolve: { code: 0, data: { markets: [] } } }, /unique USDC depeg market/],
    ["two matching markets", { resolve: { code: 0, data: { markets: [{ market_info: MARKET }, { market_info: { ...MARKET, id: 5 } }] } } }, /unique/],
    ["an ended market", { resolve: { code: 0, data: { markets: [{ market_info: { ...MARKET, end_time: "2026-01-01T00:00:00Z" } }] } } }, /has ended/],
    ["quota used up (402)", { status: 402 }, /HTTP 402/],
    ["credits used up (22002)", { probability: { code: 22002, data: {} } }, /credits are used up/],
    ["a probability above 1", { probability: { code: 0, data: { probability: 1.5, basis: [{ source: "X" }] } } }, /out of range/],
    ["a missing probability", { probability: { code: 0, data: { basis: [{ source: "X" }] } } }, /out of range/],
    ["no sources", { probability: { code: 0, data: { probability: 0.02, basis: [] } } }, /no sources/],
    ["an answer about another market", { probability: { code: 0, data: { probability: 0.02, basis: [{ source: "X" }], markets: [{ market_info: { id: 9 } }] } } }, /different market/],
  ];
  for (const [what, setup, message] of refusals) {
    it(`refuses ${what} instead of guessing`, async () => {
      await expect(readDepeg({ fetch: cournot(setup).fetch, now: () => NOW })).rejects.toThrow(message);
    });
  }

  it("keeps only http(s) links without credentials in sources", () => {
    expect(sourcesIn([{ source: "A", url: "https://user:pw@example.com" }, { source: "B", url: "ftp://x" }, { source: "C", url: "https://ok.example/" }])).toEqual([
      { title: "A" },
      { title: "B" },
      { title: "C", url: "https://ok.example/" },
    ]);
  });
});

describe("depeg guard", () => {
  const reading: DepegReading = {
    claim: DEPEG_QUESTION,
    marketId: "4242",
    marketTitle: "USDC depeg by December 31?",
    probability: 0.05,
    sources: [{ title: "Polymarket" }],
    fetchedAt: NOW.toISOString(),
    requestId: null,
  };

  it("pays in USDT only when the risk is strictly above the owner's limit", () => {
    expect(chooseToken(0.05, 5)).toBe("USDC");
    expect(chooseToken(0.0501, 5)).toBe("USDT");
    expect(chooseToken(0.032, 1)).toBe("USDT");
  });

  it("shares one Cournot reading for 10 minutes, then reads again", async () => {
    let now = 0;
    const read = vi.fn(async () => reading);
    const guard = createDepegGuard({ read, now: () => now });
    await Promise.all([guard.decide(5), guard.decide(5)]);
    await guard.decide(1);
    expect(read).toHaveBeenCalledTimes(1);
    now = 10 * 60 * 1000 + 1;
    await guard.decide(5);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable without caching the failure, so the next plan tries again", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(reading);
    const guard = createDepegGuard({ read });
    expect(await guard.decide(5)).toEqual({ available: false, threshold: 5, reason: "Cournot couldn't be reached." });
    expect(await guard.decide(5)).toMatchObject({ available: true, chosenToken: "USDC" });
  });
});

describe("plans with the depeg guard", () => {
  const draft: PlanDraft = {
    kind: "payment",
    payments: [
      { recipient_name: "Linh", recipient_address: "", amount: "300", currency: "USD" },
      { recipient_name: "Marco", recipient_address: "", amount: "450", currency: "USD" },
    ],
    scheduled_for: "now",
    notes: [],
  };

  function app(guard: DepegGuard) {
    const dir = tempDir();
    const gateway = new FakeGateway();
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    const directory = new RecipientDirectory(path.join(dir, "recipients.json"));
    directory.upsert(OWNER, { name: "Linh", address: LINH });
    directory.upsert(OWNER, { name: "Marco", address: MARCO });
    const api = createApp({ gateway, planner: async () => draft, directory, journal, executor: new Executor({ gateway, journal }), depeg: guard });
    return {
      journal,
      create: async (body: Record<string, unknown>) => {
        const response = await api.request("/plans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: OWNER, message: "Pay Linh 300 and Marco 450", ...body }),
        });
        return { status: response.status, plan: (await response.json()) as any };
      },
    };
  }

  const guardAt = (probability: number) => createDepegGuard({ read: async () => ({ ...reading(), probability }) });
  const reading = (): DepegReading => ({
    claim: DEPEG_QUESTION,
    marketId: "4242",
    marketTitle: "USDC depeg by December 31?",
    probability: 0.032,
    sources: [{ title: "Polymarket", url: "https://polymarket.com/event/usdc-depeg" }],
    fetchedAt: NOW.toISOString(),
    requestId: "req-123",
  });

  it("pays in USDC within the limit and switches every payment to USDT above it", async () => {
    const within = await app(guardAt(0.032)).create({ depegThreshold: 5 });
    expect(within.plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDC", "USDC"]);
    expect(within.plan.depeg).toMatchObject({ available: true, probability: 0.032, threshold: 5, chosenToken: "USDC", requestId: "req-123" });

    const above = await app(guardAt(0.032)).create({ depegThreshold: 1 });
    expect(above.plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDT", "USDT"]);
    expect(above.plan.notes.at(-1)).toBe("Depeg guard: Cournot puts USDC's depeg risk at 3.2%, above your 1% limit, so every payment is in USDT.");
  });

  it("uses the 5% default limit when the owner sends none", async () => {
    expect((await app(guardAt(0.06)).create({})).plan.depeg).toMatchObject({ threshold: 5, chosenToken: "USDT" });
  });

  it("puts the guard's decision into the text the owner signs", async () => {
    const t = app(guardAt(0.032));
    const { plan } = await t.create({ depegThreshold: 1 });
    const text = approvalMessage(t.journal.plan(plan.id)!, { expires: "2026-11-26T06:40:00.000Z", payEarly: false });
    expect(text).toContain("Depeg guard: Cournot puts USDC's depeg risk at 3.2%, above your 1% limit, so every payment is in USDT.");
    expect(text).toContain("300 USDT to Linh");
  });

  it("keeps the planned coins and says so when Cournot is unavailable", async () => {
    const down = createDepegGuard({ read: async () => Promise.reject(new Error("down")) });
    const { plan } = await app(down).create({ depegThreshold: 5 });
    expect(plan.depeg).toEqual({ available: false, threshold: 5, reason: "Cournot couldn't be reached." });
    expect(plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDT", "USDT"]);
    expect(plan.notes.at(-1)).toMatch(/^Depeg guard: Cournot couldn't be reached\./);
  });

  it("refuses a threshold outside 0 to 100", async () => {
    expect((await app(guardAt(0.03)).create({ depegThreshold: 120 })).status).toBe(400);
  });
});
