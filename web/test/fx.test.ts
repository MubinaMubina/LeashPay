import { describe, expect, it, vi } from "vitest";
import { createFxHandler, parseQuote } from "@/lib/fx";

const NOW = Date.parse("2026-11-26T03:40:00Z");
const STAMP = "2026-11-26T03:38:03.000Z";
const answer = (currency: string, usdt: unknown = 25809.19, stamp = STAMP) => ({
  status: { error_code: 0 },
  data: [
    { id: 825, symbol: "USDT", quote: [{ symbol: currency, price: usdt, last_updated: stamp }] },
    { id: 3408, symbol: "USDC", quote: [{ symbol: currency, price: 25842.33, last_updated: stamp }] },
  ],
});

function cmc(body: unknown, status = 200) {
  const calls: { url: string; key: string | null }[] = [];
  const fetchFn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), key: new Headers(init.headers).get("x-cmc_pro_api_key") });
    return new Response(JSON.stringify(body), { status });
  });
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}

describe("parseQuote", () => {
  it("reads both coins and refuses anything it can't trust", () => {
    expect(parseQuote(answer("VND"), "VND", NOW)).toEqual({ currency: "VND", USDT: 25809.19, USDC: 25842.33, quotedAt: STAMP });
    expect(parseQuote(answer("PHP"), "VND", NOW)).toBeNull();
    expect(parseQuote(answer("VND", 0), "VND", NOW)).toBeNull();
    expect(parseQuote(answer("VND", "25809"), "VND", NOW)).toBeNull();
    expect(parseQuote(answer("VND", 25809, "2026-11-26T02:00:00Z"), "VND", NOW)).toBeNull();
    expect(parseQuote({ ...answer("VND"), status: { error_code: 1008 } }, "VND", NOW)).toBeNull();
    expect(parseQuote("junk", "VND", NOW)).toBeNull();
    const future = answer("VND");
    future.data[1]!.quote[0]!.last_updated = "2027-11-26T03:38:03.000Z";
    expect(parseQuote(future, "VND", NOW)).toBeNull();
  });
});

describe("GET /api/fx/:currency", () => {
  it("answers the demo currencies with the key on the server, and caches each for 5 minutes", async () => {
    let t = NOW;
    const c = cmc(answer("VND"));
    const handle = createFxHandler({ apiKey: "k", fetch: c.fetch, now: () => t });
    const first = await handle("vnd");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ currency: "VND", USDT: 25809.19, USDC: 25842.33, quotedAt: STAMP });
    expect(c.calls[0]).toEqual({ url: "https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?id=825,3408&convert=VND", key: "k" });
    t += 4 * 60 * 1000;
    await handle("VND");
    expect(c.calls).toHaveLength(1);
  });

  it("quotes both stablecoins in USD for the bank preview in one market request", async () => {
    const payload = answer("USD", 0.99);
    payload.data[1].quote[0].price = 1.01;
    const c = cmc(payload);
    const handle = createFxHandler({ apiKey: "k", fetch: c.fetch, now: () => NOW });
    const response = await handle("usd");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ currency: "USD", USDT: 0.99, USDC: 1.01, quotedAt: STAMP });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].url).toContain("convert=USD");
  });

  it("shares one CoinMarketCap call across a burst of visitors", async () => {
    const c = cmc(answer("PHP"));
    const handle = createFxHandler({ apiKey: "k", fetch: c.fetch, now: () => NOW });
    const answers = await Promise.all(Array.from({ length: 50 }, () => handle("PHP")));
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(c.calls).toHaveLength(1);
  });

  it("asks again once the quote passes its freshness limit, even within 5 minutes", async () => {
    let t = Date.parse(STAMP) + 28 * 60 * 1000;
    const c = cmc(answer("VND"));
    const handle = createFxHandler({ apiKey: "k", fetch: c.fetch, now: () => t });
    await handle("VND");
    t += 3 * 60 * 1000;
    await handle("VND");
    expect(c.calls).toHaveLength(2);
  });

  it("refuses other currencies without calling, and says when the key is missing", async () => {
    const c = cmc(answer("EUR"));
    const handle = createFxHandler({ apiKey: "k", fetch: c.fetch, now: () => NOW });
    for (const code of ["EUR", "USD&convert=EUR", "VND&convert=EUR"]) expect((await handle(code)).status).toBe(400);
    expect(c.calls).toHaveLength(0);
    expect((await createFxHandler({ fetch: c.fetch })("PHP")).status).toBe(503);
  });

  it("answers 502 without the provider's error, and waits 30 s before asking again", async () => {
    let t = NOW;
    const c = cmc({ status: { error_code: 1002, error_message: "API key k is invalid" } }, 401);
    const handle = createFxHandler({ apiKey: "k", fetch: c.fetch, now: () => t });
    const response = await handle("THB");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("k is invalid");
    t += 10_000;
    await handle("THB");
    expect(c.calls).toHaveLength(1);
    t += 25_000;
    await handle("THB");
    expect(c.calls).toHaveLength(2);
  });
});
