import type { TokenSymbol } from "../plan/directory";
import { CournotError, readDepeg, type DepegReading, type DepegSource } from "./cournot";

/**
 * The depeg guard: before a payout, the agent asks Cournot how likely USDC is to depeg. Above
 * the owner's threshold it pays in USDT instead of USDC. The decision is recorded on the plan,
 * shown on the plan card and included in the text the owner signs.
 */

/** The owner's default: switch away from USDC when Cournot puts its depeg risk above 5%. */
export const DEFAULT_THRESHOLD_PERCENT = 5;
/** Cournot's paid quota is precious: one reading serves every plan for this long. */
const CACHE_MS = 10 * 60 * 1000;

export type DepegDecision =
  | {
      available: true;
      claim: string;
      marketId: string;
      marketTitle: string;
      /** 0 to 1, as Cournot returned it. */
      probability: number;
      /** The owner's limit, in percent (0 to 100). */
      threshold: number;
      chosenToken: TokenSymbol;
      sources: DepegSource[];
      fetchedAt: string;
      requestId: string | null;
    }
  | { available: false; threshold: number; reason: string };

/** USDT when the USDC depeg probability is above the threshold, otherwise USDC. */
export function chooseToken(probability: number, thresholdPercent: number): TokenSymbol {
  return probability * 100 > thresholdPercent ? "USDT" : "USDC";
}

export interface DepegGuard {
  decide(thresholdPercent: number): Promise<DepegDecision>;
}

export function createDepegGuard(options: { read?: () => Promise<DepegReading>; apiKey?: string; now?: () => number } = {}): DepegGuard {
  const read = options.read ?? (() => readDepeg({ apiKey: options.apiKey }));
  const now = options.now ?? Date.now;
  let cached: { until: number; reading: DepegReading } | null = null;
  let inFlight: Promise<DepegReading> | null = null;

  async function reading(): Promise<DepegReading> {
    if (cached && cached.until > now()) return cached.reading;
    // Plans made at the same moment share one Cournot call.
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    const fresh = await inFlight;
    cached = { until: now() + CACHE_MS, reading: fresh };
    return fresh;
  }

  return {
    async decide(thresholdPercent) {
      try {
        const r = await reading();
        return {
          available: true,
          claim: r.claim,
          marketId: r.marketId,
          marketTitle: r.marketTitle,
          probability: r.probability,
          threshold: thresholdPercent,
          chosenToken: chooseToken(r.probability, thresholdPercent),
          sources: r.sources,
          fetchedAt: r.fetchedAt,
          requestId: r.requestId,
        };
      } catch (err) {
        // A failed call is never cached, so the next plan tries again.
        const reason = err instanceof CournotError ? err.message : "Cournot couldn't be reached.";
        return { available: false, threshold: thresholdPercent, reason };
      }
    },
  };
}

/** "3.2%": Cournot's probability as the owner reads it. */
export const percent = (probability: number) => `${Number((probability * 100).toFixed(2))}%`;
