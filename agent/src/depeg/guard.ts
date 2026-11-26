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
/** After a failed call, plans answer "unavailable" at once for this long instead of waiting on Cournot again. */
const FAILURE_MS = 30 * 1000;

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

/** A probability (0 to 1) or a percent, in hundredths of a percent: the precision the owner reads. */
const hundredths = (probability: number) => Math.round(probability * 10_000);

/**
 * USDT when the USDC depeg risk, as the owner reads it (to 0.01%), is strictly above the threshold;
 * otherwise USDC. Deciding on the printed value keeps the signed sentence true: 0.05004 reads "5%",
 * so against a 5% limit it is within, never "5% above your 5% limit". Comparing whole hundredths
 * also avoids float drift (0.035 * 100 is 3.5000000000000004).
 */
export function chooseToken(probability: number, thresholdPercent: number): TokenSymbol {
  return hundredths(probability) > hundredths(thresholdPercent / 100) ? "USDT" : "USDC";
}

export interface DepegGuard {
  decide(thresholdPercent: number): Promise<DepegDecision>;
}

export function createDepegGuard(options: { read?: () => Promise<DepegReading>; apiKey?: string; now?: () => number } = {}): DepegGuard {
  const read = options.read ?? (() => readDepeg({ apiKey: options.apiKey }));
  const now = options.now ?? Date.now;
  let cached: { until: number; reading: DepegReading } | null = null;
  let inFlight: Promise<DepegReading> | null = null;
  let failed: { until: number; reason: string } | null = null;

  async function reading(): Promise<DepegReading> {
    if (cached && cached.until > now()) return cached.reading;
    if (failed && failed.until > now()) throw new CournotError(failed.reason);
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
        // Remembered briefly, so plans made during an outage don't each wait out the deadline.
        const reason = err instanceof CournotError ? err.message : "Cournot couldn't be reached.";
        if (!(failed && failed.until > now())) failed = { until: now() + FAILURE_MS, reason };
        return { available: false, threshold: thresholdPercent, reason };
      }
    },
  };
}

/** "3.2%": Cournot's probability as the owner reads it, to 0.01%. */
export const percent = (probability: number) => `${hundredths(probability) / 100}%`;
