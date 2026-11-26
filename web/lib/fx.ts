/**
 * GET /api/fx/:currency for the recipient's phone page: what 1 USDT and 1 USDC are worth today
 * in their currency, from CoinMarketCap. Public (recipients have no login), so it takes only the
 * demo's currencies and caches each one: a stranger can't spend the plan's credits.
 */

/** The demo recipients' currencies (Vietnam, the Philippines, Thailand). */
export const FX_CURRENCIES = ["VND", "PHP", "THB"] as const;
const CACHE_MS = 5 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const MAX_QUOTE_AGE_MS = 30 * 60 * 1000;
const COIN_IDS = { USDT: 825, USDC: 3408 } as const;

export interface FxRates {
  currency: string;
  USDT: number;
  USDC: number;
  /** CoinMarketCap's quote time (the older coin), ISO. */
  quotedAt: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads CoinMarketCap's v3 answer for one currency; null when anything in it can't be trusted. */
export function parseQuote(payload: unknown, currency: string, now: number): FxRates | null {
  if (!isRecord(payload) || !isRecord(payload.status) || String(payload.status.error_code) !== "0") return null;
  const assets = Array.isArray(payload.data) ? payload.data : [];
  const rates: Partial<Record<"USDT" | "USDC", number>> = {};
  let oldest = Infinity;
  for (const token of ["USDT", "USDC"] as const) {
    const asset = assets.find((a) => isRecord(a) && a.id === COIN_IDS[token] && a.symbol === token);
    const quote = (isRecord(asset) && Array.isArray(asset.quote) ? asset.quote : []).find((q) => isRecord(q) && q.symbol === currency);
    if (!isRecord(quote) || typeof quote.price !== "number" || !Number.isFinite(quote.price) || quote.price <= 0) return null;
    const stamp = typeof quote.last_updated === "string" ? Date.parse(quote.last_updated) : Number.NaN;
    // Each coin on its own: a fresh one must not hide a stale or future-dated other.
    if (!Number.isFinite(stamp) || now - stamp > MAX_QUOTE_AGE_MS || stamp - now > 2 * 60 * 1000) return null;
    rates[token] = quote.price;
    oldest = Math.min(oldest, stamp);
  }
  return { currency, USDT: rates.USDT!, USDC: rates.USDC!, quotedAt: new Date(oldest).toISOString() };
}

export function createFxHandler(deps: { apiKey?: string; fetch?: typeof fetch; now?: () => number }) {
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { until: number; rates: FxRates }>();
  const failed = new Map<string, number>();
  const inFlight = new Map<string, Promise<FxRates | null>>();

  /** One CoinMarketCap call per currency at a time: a burst of visitors shares it. */
  async function fresh(currency: string, apiKey: string): Promise<FxRates | null> {
    try {
      const response = await fetchFn(
        `https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest?id=${COIN_IDS.USDT},${COIN_IDS.USDC}&convert=${currency}`,
        { headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": apiKey }, redirect: "error", signal: AbortSignal.timeout(10_000) },
      );
      const rates = response.ok ? parseQuote(await response.json(), currency, now()) : null;
      if (rates) cache.set(currency, { until: Math.min(now() + CACHE_MS, Date.parse(rates.quotedAt) + MAX_QUOTE_AGE_MS), rates });
      else failed.set(currency, now() + FAILURE_MS);
      return rates;
    } catch {
      failed.set(currency, now() + FAILURE_MS);
      return null;
    }
  }

  return async (raw: string): Promise<Response> => {
    const currency = raw.toUpperCase();
    if (!(FX_CURRENCIES as readonly string[]).includes(currency)) return json(400, { error: `Rates are offered for ${FX_CURRENCIES.join(", ")} only.` });
    if (!deps.apiKey) return json(503, { error: "The web server needs CMC_API_KEY in .env for local-currency values." });
    const hit = cache.get(currency);
    if (hit && hit.until > now()) return json(200, hit.rates);
    if ((failed.get(currency) ?? 0) > now()) return json(502, { error: "CoinMarketCap isn't answering right now." });
    let pending = inFlight.get(currency);
    if (!pending) {
      pending = fresh(currency, deps.apiKey).finally(() => inFlight.delete(currency));
      inFlight.set(currency, pending);
    }
    const rates = await pending;
    // Never echo the error: it could carry the request, and the request carries the key.
    return rates ? json(200, rates) : json(502, { error: "CoinMarketCap isn't answering right now." });
  };
}
