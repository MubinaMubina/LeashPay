import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { DEPEG_QUESTION } from "../src/depeg/cournot";
import { createDepegGuard } from "../src/depeg/guard";
import { approvalMessage } from "../src/execution/approval";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { CmcError, readQuote, type FxQuote } from "../src/fx/cmc";
import { createFx, type FxService } from "../src/fx/rates";
import { RecipientDirectory } from "../src/plan/directory";
import type { PlanDraft } from "../src/plan/schema";
import { FakeGateway, LINH, MARCO, OWNER, tempDir } from "./fakes";

const NOW = new Date("2026-11-26T03:40:00Z");
const STAMP = "2026-11-26T03:35:05.000Z";

const answer = (currency: string, over: { usdt?: unknown; usdc?: unknown; stamp?: string; code?: unknown } = {}) => ({
  status: { error_code: over.code ?? 0, credit_count: 1 },
  data: [
    { id: 825, symbol: "USDT", quote: [{ symbol: currency, price: over.usdt ?? 25820.49, last_updated: over.stamp ?? STAMP }] },
    { id: 3408, symbol: "USDC", quote: [{ symbol: currency, price: over.usdc ?? 25847.6, last_updated: over.stamp ?? STAMP }] },
  ],
});

function cmc(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}

const read = (currency: string, fetchFn: typeof fetch) => readQuote(currency, { fetch: fetchFn, apiKey: "k", now: () => NOW });

describe("readQuote (CoinMarketCap)", () => {
  it("reads both coins in one call with the key, and keeps CoinMarketCap's time", async () => {
    const c = cmc(answer("VND"));
    await expect(read("VND", c.fetch)).resolves.toEqual({ currency: "VND", rates: { USDT: 25820.49, USDC: 25847.6 }, quotedAt: STAMP });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.url).toBe("https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?id=825,3408&convert=VND");
    expect(c.calls[0]!.headers["x-cmc_pro_api_key"]).toBe("k");
  });

  it("refuses dollars, odd codes and a missing key without calling", async () => {
    const c = cmc(answer("VND"));
    for (const code of ["USD", "USDT", "vnd", "VND&x=1", ""]) await expect(read(code, c.fetch)).rejects.toThrow(CmcError);
    await expect(readQuote("VND", { fetch: c.fetch, now: () => NOW })).rejects.toThrow(/CMC_API_KEY/);
    expect(c.calls).toHaveLength(0);
  });

  const cases: [string, ReturnType<typeof cmc>, RegExp][] = [
    ["a bad key", cmc({}, 401), /HTTP 401\. Check CMC_API_KEY/],
    ["the rate limit", cmc({}, 429), /HTTP 429\. Too many requests/],
    ["a refusal in the body", cmc(answer("VND", { code: 400 })), /refused the quote \(code 400\)/],
    ["a missing coin", cmc({ status: { error_code: 0 }, data: [answer("VND").data[0]] }), /no USDC price in VND/],
    ["a quote in another currency", cmc(answer("PHP")), /no USDT price in VND/],
    ["a zero price", cmc(answer("VND", { usdt: 0 })), /USDT price in VND is invalid/],
    ["a price as text", cmc(answer("VND", { usdc: "25000" })), /USDC price in VND is invalid/],
    ["an old quote", cmc(answer("VND", { stamp: "2026-11-26T02:00:00Z" })), /out of date/],
    ["no time", cmc(answer("VND", { stamp: "soon" })), /no readable time/],
    [
      "one coin dated in the future",
      cmc({ ...answer("VND"), data: [answer("VND").data[0], { ...answer("VND").data[1], quote: [{ symbol: "VND", price: 25847.6, last_updated: "2027-11-26T03:35:00Z" }] }] }),
      /out of date/,
    ],
    ["junk", cmc("not json"), /unreadable/],
  ];
  for (const [what, c, message] of cases) {
    it(`refuses ${what}`, async () => {
      await expect(read("VND", c.fetch)).rejects.toThrow(message);
    });
  }

  it("says when CoinMarketCap is unreachable or too slow", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(read("VND", down)).rejects.toThrow("CoinMarketCap couldn't be reached.");
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(readQuote("VND", { fetch: slow, apiKey: "k", now: () => NOW, timeoutMs: 20 })).rejects.toThrow("didn't answer within 0.02 s");
  });
});

const quote = (currency: string, usdt = 25820.49, usdc = 25847.6): FxQuote => ({ currency, rates: { USDT: usdt, USDC: usdc }, quotedAt: STAMP });

describe("fx cache", () => {
  it("asks once per currency, shares a call in flight and reuses it for 5 minutes", async () => {
    let t = 0;
    const reader = vi.fn(async (c: string) => quote(c));
    const fx = createFx({ read: reader, now: () => t });
    await Promise.all([fx.quotes(["VND", "PHP", "VND", "USD"]), fx.quotes(["VND"])]);
    expect(reader.mock.calls.map((c) => c[0]).sort()).toEqual(["PHP", "VND"]);
    t = 4 * 60 * 1000;
    await fx.quotes(["VND"]);
    expect(reader).toHaveBeenCalledTimes(2);
    t = 6 * 60 * 1000;
    await fx.quotes(["VND"]);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("never keeps a quote past its 30-minute freshness limit", async () => {
    let t = Date.parse(STAMP) + 28 * 60 * 1000;
    const reader = vi.fn(async (c: string) => quote(c));
    const fx = createFx({ read: reader, now: () => t });
    await fx.quotes(["VND"]);
    t += 3 * 60 * 1000; // within 5 minutes of the call, but 31 minutes after the quote
    await fx.quotes(["VND"]);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("remembers a failure for 30 seconds and never throws", async () => {
    let t = 0;
    const reader = vi.fn(async () => Promise.reject(new CmcError("CoinMarketCap answered HTTP 429. Too many requests.")));
    const fx = createFx({ read: reader, now: () => t });
    expect((await fx.quotes(["VND"])).get("VND")).toEqual({ currency: "VND", error: "CoinMarketCap answered HTTP 429. Too many requests." });
    t = 20_000;
    await fx.quotes(["VND"]);
    expect(reader).toHaveBeenCalledTimes(1);
    t = 31_000;
    await fx.quotes(["VND"]);
    expect(reader).toHaveBeenCalledTimes(2);
    const odd = createFx({ read: async () => Promise.reject(new Error("socket")) });
    expect((await odd.quotes(["PHP"])).get("PHP")).toEqual({ currency: "PHP", error: "CoinMarketCap couldn't be reached." });
  });
});

describe("plans with local-currency amounts", () => {
  const draft: PlanDraft = {
    kind: "payment",
    payments: [
      { recipient_name: "Linh", recipient_address: "", amount: "300", currency: "USD" },
      { recipient_name: "Marco", recipient_address: "", amount: "450", currency: "USD" },
    ],
    scheduled_for: "now",
    notes: [],
  };

  function app(fx: FxService, options: { marcoCurrency?: string; depegAt?: number } = {}) {
    const dir = tempDir();
    const gateway = new FakeGateway();
    const journal = new Journal(path.join(dir, "journal.jsonl"));
    const directory = new RecipientDirectory(path.join(dir, "recipients.json"));
    directory.upsert(OWNER, { name: "Linh", address: LINH, country: "VN", currency: "vnd" });
    directory.upsert(OWNER, { name: "Marco", address: MARCO, country: "PH", currency: options.marcoCurrency ?? "PHP" });
    const depeg =
      options.depegAt === undefined
        ? undefined
        : createDepegGuard({
            read: async () => ({
              claim: DEPEG_QUESTION,
              marketId: "4242",
              marketTitle: "USDC depeg by December 31?",
              probability: options.depegAt!,
              sources: [{ title: "Polymarket" }],
              fetchedAt: "2026-11-26T03:40:00.000Z",
              requestId: null,
            }),
          });
    const api = createApp({ gateway, planner: async () => draft, directory, journal, executor: new Executor({ gateway, journal }), fx, depeg });
    return {
      journal,
      create: async () => {
        const response = await api.request("/plans", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: OWNER, message: "Pay Linh 300 and Marco 450" }),
        });
        return { status: response.status, plan: (await response.json()) as any };
      },
    };
  }

  const rates: Record<string, FxQuote> = { VND: quote("VND"), PHP: quote("PHP", 63.63, 63.69) };

  it("shows each payment in its recipient's currency at the rate of the coin paid", async () => {
    const t = app(createFx({ read: async (c) => rates[c]! }), { depegAt: 0.01 });
    const { status, plan } = await t.create();
    expect(status).toBe(201);
    expect(plan.payments.map((p: { token: string }) => p.token)).toEqual(["USDC", "USDC"]);
    expect(plan.payments[0].local).toEqual({ currency: "VND", amount: 300 * 25847.6, rate: 25847.6, quotedAt: STAMP, source: "CoinMarketCap" });
    expect(plan.payments[1].local).toMatchObject({ currency: "PHP", rate: 63.69 });
    expect(plan.payments[1].local.amount).toBeCloseTo(450 * 63.69, 6);
  });

  it("uses the USDT rate once the depeg guard switches coins", async () => {
    const { plan } = await app(createFx({ read: async (c) => rates[c]! }), { depegAt: 0.2 }).create();
    expect(plan.payments[0]).toMatchObject({ token: "USDT", local: { rate: 25820.49 } });
  });

  it("skips recipients paid in dollars and keeps the plan when CoinMarketCap fails", async () => {
    const reader = vi.fn(async () => Promise.reject(new CmcError("CoinMarketCap answered HTTP 429. Too many requests.")));
    const { status, plan } = await app(createFx({ read: reader }), { marcoCurrency: "USD" }).create();
    expect(status).toBe(201);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(plan.payments[0].local).toEqual({ currency: "VND", error: "CoinMarketCap answered HTTP 429. Too many requests." });
    expect(plan.payments[1].local).toBeUndefined();
  });

  it("keeps local amounts out of the text the owner signs and in the journal", async () => {
    const t = app(createFx({ read: async (c) => rates[c]! }));
    const { plan } = await t.create();
    const saved = t.journal.plan(plan.id)!;
    expect(saved.payments[0]!.local).toMatchObject({ currency: "VND" });
    const text = approvalMessage(saved, { expires: "2026-11-26T03:50:00.000Z", payEarly: false });
    expect(text).not.toMatch(/VND|PHP|CoinMarketCap/);
  });
});
