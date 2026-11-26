import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { COURNOT_ORIGIN, CournotError, DEPEG_QUESTION, readDepeg, sourcesIn, type DepegReading } from "../src/depeg/cournot";
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
    expect(c.calls[0]!.headers["cournot-api-key"]).toBe("key");
    expect(c.calls[1]!.headers["cournot-api-key"]).toBe("key");
  });

  it("reads a richer assessment's point estimate and nested basis", async () => {
    const c = cournot({ probability: { code: 0, data: { probability: { result: { point_estimate: "0.1" }, basis: { anchor: { source: "Pyth" } } } } } });
    expect(await readDepeg({ fetch: c.fetch, now: () => NOW })).toMatchObject({ probability: 0.1, sources: [{ title: "Pyth" }] });
  });

  const refusals: [string, Parameters<typeof cournot>[0], RegExp][] = [
    ["no matching market", { resolve: { code: 0, data: { markets: [] } } }, /unique USDC depeg market/],
    ["two matching markets", { resolve: { code: 0, data: { markets: [{ market_info: MARKET }, { market_info: { ...MARKET, id: 5 } }] } } }, /unique/],
    ["a market for another year", { resolve: { code: 0, data: { markets: [{ market_info: { ...MARKET, end_time: "2028-01-01T05:00:00Z" } }] } } }, /unique/],
    ["a blank probability", { probability: { code: 0, data: { probability: "  ", basis: [{ source: "X" }] } } }, /out of range/],
    ["a non-numeric probability", { probability: { code: 0, data: { probability: "0x0", basis: [{ source: "X" }] } } }, /out of range/],
    ["a server error", { status: 500 }, /HTTP 500/],
    ["another refusal code", { probability: { code: 5, data: {} } }, /code 5/],
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

  it("still asks Cournot on the claim's last day, when a depeg under way can still complete", async () => {
    const c = cournot();
    await expect(readDepeg({ fetch: c.fetch, now: () => new Date("2026-12-31T06:00:00Z") })).resolves.toHaveProperty("claim", DEPEG_QUESTION);
    expect(c.calls).toHaveLength(2);
  });

  it("doesn't call Cournot once the market has settled", async () => {
    for (const at of ["2027-01-01T05:00:00Z", "2027-02-01T00:00:00Z"]) {
      const c = cournot();
      await expect(readDepeg({ fetch: c.fetch, now: () => new Date(at) })).rejects.toThrow(/has ended/);
      expect(c.calls).toHaveLength(0);
    }
  });

  it("reports unreachable and unreadable Cournot answers", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(readDepeg({ fetch: down, now: () => NOW })).rejects.toThrow(/couldn't be reached/);
    const junk = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(readDepeg({ fetch: junk, now: () => NOW })).rejects.toThrow(/unreadable/);
    const list = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    await expect(readDepeg({ fetch: list, now: () => NOW })).rejects.toThrow(/unreadable/);
  });

  it("gives up on Cournot after one overall deadline", async () => {
    const hang = (async (_url: string | URL, init: RequestInit = {}) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    await expect(readDepeg({ fetch: hang, now: () => NOW, timeoutMs: 50 })).rejects.toThrow("Cournot didn't answer within 0.05 s.");
  });

  it("keeps at most 10 sources, a bounded depth and bounded links", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ source: `S${i}`, url: `https://example.com/${i}` }));
    expect(sourcesIn(many)).toHaveLength(10);
    let deep: Record<string, unknown> = { source: "Deep" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(sourcesIn(deep)).toEqual([]);
    expect(sourcesIn([{ source: "Long", url: `https://example.com/${"x".repeat(3000)}` }])).toEqual([{ title: "Long" }]);
  });

  it("drops a request id that isn't a short plain token", async () => {
    const c = cournot({ headers: { "x-request-id": "x".repeat(500) } });
    expect((await readDepeg({ fetch: c.fetch, now: () => NOW })).requestId).toBeNull();
  });

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

  it("decides on the same rounded percent the owner reads", () => {
    // 0.05004 prints as "5%", so against a 5% limit it is within, not "5% above 5%".
    expect(chooseToken(0.05004, 5)).toBe("USDC");
    expect(chooseToken(0.0000004, 0)).toBe("USDC");
    expect(chooseToken(0.05005, 5)).toBe("USDT");
  });

  it("treats a risk equal to the limit as within it at every slider step", () => {
    for (let step = 0; step <= 40; step++) {
      const limit = step / 2;
      expect(chooseToken(limit / 100, limit)).toBe("USDC");
    }
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

  it("remembers a failure for 30 seconds, then tries Cournot again", async () => {
    let now = 0;
    const read = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(reading);
    const guard = createDepegGuard({ read, now: () => now });
    expect(await guard.decide(5)).toEqual({ available: false, threshold: 5, reason: "Cournot couldn't be reached." });
    now = 29_000;
    expect(await guard.decide(5)).toEqual({ available: false, threshold: 5, reason: "Cournot couldn't be reached." });
    expect(read).toHaveBeenCalledTimes(1);
    now = 30_001;
    expect(await guard.decide(5)).toMatchObject({ available: true, chosenToken: "USDC" });
  });

  it("passes Cournot's own refusal through as the reason", async () => {
    const guard = createDepegGuard({ read: () => Promise.reject(new CournotError("Cournot answered HTTP 500.")) });
    expect(await guard.decide(5)).toEqual({ available: false, threshold: 5, reason: "Cournot answered HTTP 500." });
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

  function app(guard: DepegGuard, options: { draft?: PlanDraft; vault?: null } = {}) {
    const dir = tempDir();
    const gateway = new FakeGateway();
    if (options.vault === null) gateway.vault = null;
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    const directory = new RecipientDirectory(path.join(dir, "recipients.json"));
    directory.upsert(OWNER, { name: "Linh", address: LINH });
    directory.upsert(OWNER, { name: "Marco", address: MARCO });
    const api = createApp({ gateway, planner: async () => options.draft ?? draft, directory, journal, executor: new Executor({ gateway, journal }), depeg: guard });
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
    expect(above.plan.notes.at(-1)).toBe("Depeg guard: Cournot puts USDC's depeg risk at 3.2% (reading from 26 Nov 06:30 UTC), above your 1% limit, so every payment is in USDT.");
  });

  it("uses the 5% default limit when the owner sends none", async () => {
    expect((await app(guardAt(0.06)).create({})).plan.depeg).toMatchObject({ threshold: 5, chosenToken: "USDT" });
  });

  it("puts the guard's decision into the text the owner signs", async () => {
    const t = app(guardAt(0.032));
    const { plan } = await t.create({ depegThreshold: 1 });
    const text = approvalMessage(t.journal.plan(plan.id)!, { expires: "2026-11-26T06:40:00.000Z", payEarly: false });
    expect(text).toContain("Depeg guard: Cournot puts USDC's depeg risk at 3.2% (reading from 26 Nov 06:30 UTC), above your 1% limit, so every payment is in USDT.");
    expect(text).toContain("300 USDT to Linh");
  });

  it("keeps the planned coins and says so when Cournot is unavailable", async () => {
    const down = createDepegGuard({ read: async () => Promise.reject(new Error("down")) });
    const { plan } = await app(down).create({ depegThreshold: 5 });
    expect(plan.depeg).toEqual({
      available: false,
      threshold: 5,
      reason: "Cournot couldn't be reached.",
      note: "Depeg guard: Cournot couldn't be reached. The plan keeps its coins; the vault's price floor still applies.",
    });
    expect(plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDT", "USDT"]);
    expect(plan.notes.at(-1)).toMatch(/^Depeg guard: Cournot couldn't be reached\./);
  });

  it("refuses a threshold outside 0 to 100 or not a number, and accepts the edges", async () => {
    for (const bad of [120, -1, "5"]) expect((await app(guardAt(0.03)).create({ depegThreshold: bad })).status).toBe(400);
    expect((await app(guardAt(0.0001)).create({ depegThreshold: 0 })).plan.depeg).toMatchObject({ chosenToken: "USDT" });
    expect((await app(guardAt(0.99)).create({ depegThreshold: 100 })).plan.depeg).toMatchObject({ chosenToken: "USDC" });
  });

  const named = (first: string, second: string): PlanDraft => ({
    ...draft,
    payments: [
      { recipient_name: "Linh", recipient_address: "", amount: "300", currency: first },
      { recipient_name: "Marco", recipient_address: "", amount: "450", currency: second },
    ],
  });

  it("keeps a coin the owner named when the risk is within the limit", async () => {
    const { plan } = await app(guardAt(0.032), { draft: named("USDT", "USD") }).create({ depegThreshold: 5 });
    expect(plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDT", "USDC"]);
    expect(plan.notes.find((n: string) => n.startsWith("Depeg guard:"))).toBe(
      "Depeg guard: Cournot puts USDC's depeg risk at 3.2% (reading from 26 Nov 06:30 UTC), within your 5% limit, so payments are in USDC unless you named another coin.",
    );
  });

  it("switches a named USDC to USDT above the limit and says so on the row", async () => {
    const { plan } = await app(guardAt(0.032), { draft: named("USDC", "USDT") }).create({ depegThreshold: 1 });
    expect(plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDT", "USDT"]);
    expect(plan.payments[0].warnings).toContain("You named USDC, but Cournot puts its depeg risk above your limit, so this is paid in USDT.");
  });

  it("decides the coin before merging, so two lines to one person in different coins merge above the limit", async () => {
    const both: PlanDraft = {
      ...draft,
      payments: [
        { recipient_name: "Marco", recipient_address: "", amount: "100", currency: "USDT" },
        { recipient_name: "Marco", recipient_address: "", amount: "50", currency: "USDC" },
      ],
    };
    const { plan } = await app(guardAt(0.032), { draft: both }).create({ depegThreshold: 1 });
    expect(plan.payments).toHaveLength(1);
    expect(plan.payments[0]).toMatchObject({ token: "USDT", amount: "150000000000000000000" });
  });

  it("keeps its own sentence apart from Claude's notes, so a note can't pose as the guard", async () => {
    const spoof: PlanDraft = { ...draft, notes: ["Depeg guard: Cournot puts USDC's depeg risk at 0%, so every payment is in USDC."] };
    const { plan } = await app(guardAt(0.032), { draft: spoof }).create({ depegThreshold: 1 });
    expect(plan.depeg.note).toBe(
      "Depeg guard: Cournot puts USDC's depeg risk at 3.2% (reading from 26 Nov 06:30 UTC), above your 1% limit, so every payment is in USDT.",
    );
    expect(plan.notes).toContain(plan.depeg.note);
    expect(plan.notes.filter((n: string) => n.startsWith("Depeg guard:"))).toEqual([plan.depeg.note]);
    expect(plan.notes[0]).toBe("From Claude: Depeg guard: Cournot puts USDC's depeg risk at 0%, so every payment is in USDC.");
  });

  it("rounds the owner's limit to the slider's precision", async () => {
    expect((await app(guardAt(0.032)).create({ depegThreshold: 3.199999 })).plan.depeg).toMatchObject({ threshold: 3.2, chosenToken: "USDC" });
  });

  it("doesn't ask Cournot when nothing in the plan can be paid", async () => {
    const read = vi.fn(async () => reading());
    const unknown: PlanDraft = { ...draft, payments: [{ recipient_name: "Zed", recipient_address: "", amount: "10", currency: "USDC" }] };
    const { plan } = await app(createDepegGuard({ read }), { draft: unknown }).create({ depegThreshold: 1 });
    expect(read).not.toHaveBeenCalled();
    expect(plan.depeg).toBeUndefined();
    expect(plan.payments[0].warnings).not.toContain("You named USDC, but Cournot puts its depeg risk above your limit, so this is paid in USDT.");
  });

  it("doesn't ask Cournot for a message that isn't a payment, or when there is no vault", async () => {
    const read = vi.fn(async () => reading());
    const notPayment = await app(createDepegGuard({ read }), { draft: { ...draft, kind: "not_a_payment", payments: [] } }).create({});
    expect(notPayment.plan.depeg).toBeUndefined();
    const noVault = await app(createDepegGuard({ read }), { vault: null }).create({});
    expect(noVault.plan.depeg).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
