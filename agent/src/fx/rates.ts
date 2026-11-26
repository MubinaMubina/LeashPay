import { formatUnits, type Address } from "viem";
import type { Plan } from "../plan/build";
import type { RecipientEntry } from "../plan/directory";
import { CmcError, MAX_QUOTE_AGE_MS, isLocalCurrency, readQuote, type FxQuote } from "./cmc";

/** One quote serves every plan for this long (each call costs one CoinMarketCap credit). */
const CACHE_MS = 5 * 60 * 1000;
/** After a failure, plans skip that currency at once for this long instead of waiting again. */
const FAILURE_MS = 30 * 1000;

export type FxResult = FxQuote | { currency: string; error: string };

/** What a payment is worth to its recipient, shown on the plan card. Never part of what is paid. */
export type LocalAmount =
  | { currency: string; amount: number; rate: number; quotedAt: string; source: "CoinMarketCap" }
  | { currency: string; error: string };

export interface FxService {
  /** One result per currency; never throws. */
  quotes(currencies: string[]): Promise<Map<string, FxResult>>;
}

export function createFx(options: { read?: (currency: string) => Promise<FxQuote>; apiKey?: string; now?: () => number } = {}): FxService {
  const read = options.read ?? ((currency: string) => readQuote(currency, { apiKey: options.apiKey }));
  const now = options.now ?? Date.now;
  const cached = new Map<string, { until: number; quote: FxQuote }>();
  const failed = new Map<string, { until: number; error: string }>();
  const inFlight = new Map<string, Promise<FxQuote>>();

  async function quote(currency: string): Promise<FxResult> {
    const hit = cached.get(currency);
    if (hit && hit.until > now()) return hit.quote;
    const miss = failed.get(currency);
    if (miss && miss.until > now()) return { currency, error: miss.error };
    let pending = inFlight.get(currency);
    if (!pending) {
      pending = read(currency).finally(() => inFlight.delete(currency));
      inFlight.set(currency, pending);
    }
    try {
      const fresh = await pending;
      // Never kept past the quote's own freshness limit.
      cached.set(currency, { until: Math.min(now() + CACHE_MS, Date.parse(fresh.quotedAt) + MAX_QUOTE_AGE_MS), quote: fresh });
      return fresh;
    } catch (err) {
      const error = err instanceof CmcError ? err.message : "CoinMarketCap couldn't be reached.";
      if (!(miss && miss.until > now())) failed.set(currency, { until: now() + FAILURE_MS, error });
      return { currency, error };
    }
  }

  return {
    async quotes(currencies) {
      const unique = [...new Set(currencies.filter(isLocalCurrency))];
      const results = await Promise.all(unique.map(quote));
      return new Map(results.map((r) => [r.currency, r]));
    },
  };
}

const entryFor = (directory: RecipientEntry[], address: Address | null) =>
  address ? directory.find((e) => e.address.toLowerCase() === address.toLowerCase()) : undefined;

/** The local currencies a plan's payments need: each saved recipient's own, when it isn't dollars. */
export function currenciesFor(plan: Plan, directory: RecipientEntry[]): string[] {
  const codes = plan.payments.map((p) => (p.amount !== null ? entryFor(directory, p.recipient)?.currency : undefined));
  return [...new Set(codes.filter(isLocalCurrency))];
}

/** Sets `local` on each payment whose recipient has a local currency, from the quotes fetched. */
export function attachLocalAmounts(plan: Plan, directory: RecipientEntry[], quotes: Map<string, FxResult>): void {
  for (const payment of plan.payments) {
    const currency = payment.amount !== null ? entryFor(directory, payment.recipient)?.currency : undefined;
    if (!isLocalCurrency(currency)) continue;
    const q = quotes.get(currency);
    if (!q) continue;
    if ("error" in q) {
      payment.local = { currency, error: q.error };
      continue;
    }
    const rate = q.rates[payment.token];
    // Display only: a float is precise enough for an amount rounded to the currency's unit.
    payment.local = { currency, amount: Number(formatUnits(payment.amount!, 18)) * rate, rate, quotedAt: q.quotedAt, source: "CoinMarketCap" };
  }
}
