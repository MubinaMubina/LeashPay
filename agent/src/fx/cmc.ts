import type { TokenSymbol } from "../plan/directory";

/**
 * CoinMarketCap Pro: what 1 USDT and 1 USDC are worth in a recipient's local currency, so the
 * owner sees "300 USDT ≈ 7,746,148 VND" before approving. Read-only and informational: the
 * amounts paid on-chain never depend on it.
 */

export const CMC_ORIGIN = "https://pro-api.coinmarketcap.com";
/** CoinMarketCap's ids for the two coins the vault pays in. */
const COIN_IDS: Record<TokenSymbol, number> = { USDT: 825, USDC: 3408 };
/** One call per currency (the plan allows one `convert` per call), both coins in it. */
export const CMC_DEADLINE_MS = 10_000;
/** A quote older than this is refused rather than shown as today's rate. */
const MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

export interface FxQuote {
  /** ISO 4217 code, such as "VND". */
  currency: string;
  /** Local currency units for one coin. */
  rates: Record<TokenSymbol, number>;
  /** CoinMarketCap's `last_updated` for the quote (the older of the two coins), ISO. */
  quotedAt: string;
}

export class CmcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmcError";
  }
}

/** Currencies worth converting to: a 3-letter fiat code, not the dollar the coins already track. */
export const isLocalCurrency = (code: string | undefined): code is string =>
  typeof code === "string" && /^[A-Z]{3}$/.test(code) && !["USD", "USDT", "USDC"].includes(code);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const timedOut = (signal: AbortSignal) => signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";

export async function readQuote(
  currency: string,
  options: { fetch?: typeof fetch; apiKey?: string; now?: () => Date; timeoutMs?: number } = {},
): Promise<FxQuote> {
  if (!isLocalCurrency(currency)) throw new CmcError(`${currency} isn't a currency to convert to.`);
  if (!options.apiKey) throw new CmcError("CMC_API_KEY isn't set.");
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const ms = options.timeoutMs ?? CMC_DEADLINE_MS;
  const signal = AbortSignal.timeout(ms);
  const unreachable = () => new CmcError(timedOut(signal) ? `CoinMarketCap didn't answer within ${ms / 1000} s.` : "CoinMarketCap couldn't be reached.");

  const url = `${CMC_ORIGIN}/v3/cryptocurrency/quotes/latest?id=${COIN_IDS.USDT},${COIN_IDS.USDC}&convert=${currency}`;
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json", "X-CMC_PRO_API_KEY": options.apiKey }, redirect: "error", signal });
  } catch {
    throw unreachable();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const hint: Record<number, string> = { 401: " Check CMC_API_KEY.", 402: " The plan's credits are used up.", 429: " Too many requests." };
    throw new CmcError(`CoinMarketCap answered HTTP ${response.status}.${hint[response.status] ?? ""}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (signal.aborted) throw unreachable();
    throw new CmcError("CoinMarketCap sent an unreadable answer.");
  }
  if (!isRecord(payload) || !isRecord(payload.status)) throw new CmcError("CoinMarketCap sent an unreadable answer.");
  if (String(payload.status.error_code) !== "0") throw new CmcError(`CoinMarketCap refused the quote (code ${String(payload.status.error_code)}).`);
  const assets = Array.isArray(payload.data) ? payload.data : [];

  const rates = {} as Record<TokenSymbol, number>;
  let oldest = Infinity;
  for (const token of ["USDT", "USDC"] as const) {
    const asset = assets.find((a) => isRecord(a) && a.id === COIN_IDS[token] && a.symbol === token);
    const quotes = isRecord(asset) && Array.isArray(asset.quote) ? asset.quote : [];
    const quote = quotes.find((q) => isRecord(q) && q.symbol === currency);
    if (!isRecord(quote)) throw new CmcError(`CoinMarketCap gave no ${token} price in ${currency}.`);
    const price = quote.price;
    const stamp = typeof quote.last_updated === "string" ? Date.parse(quote.last_updated) : Number.NaN;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new CmcError(`CoinMarketCap's ${token} price in ${currency} is invalid.`);
    if (!Number.isFinite(stamp)) throw new CmcError(`CoinMarketCap's ${token} quote has no readable time.`);
    rates[token] = price;
    oldest = Math.min(oldest, stamp);
  }
  const age = now().getTime() - oldest;
  if (age > MAX_QUOTE_AGE_MS || age < -2 * 60 * 1000) throw new CmcError(`CoinMarketCap's ${currency} quote is out of date.`);
  return { currency, rates, quotedAt: new Date(oldest).toISOString() };
}
