/**
 * The depeg guard's data: a live Cournot Intelligence Oracle reading of how likely USDC is to
 * depeg. Ported from Builder A's verified terminal check (scripts/demo_oracles.py): resolve the
 * market from the question, then ask for its probability and the evidence behind it.
 *
 *   POST /intelligence/v1/resolve      { message, limit }        -> candidate markets
 *   POST /intelligence/v1/probability  { message, market_ids }   -> probability + basis (sources)
 *
 * Nothing here is ever mocked or hard-coded in the running agent: a reading either comes from
 * Cournot with its sources, or the guard reports that it is unavailable.
 */

export const COURNOT_ORIGIN = "https://interface.cournot.ai";

/** The exact claim sent to Cournot and shown to the owner (Cournot track: the claim must be visible). */
export const DEPEG_QUESTION = "Will USDC depeg below $0.98 for 24 consecutive hours by December 31, 2026?";

const MARKET_TITLE = "USDC depeg by December 31?";

export interface DepegSource {
  title: string;
  url?: string;
  time?: string;
}

export interface DepegReading {
  claim: string;
  marketId: string;
  marketTitle: string;
  /** 0 to 1: Cournot's estimate that the claim comes true. */
  probability: number;
  sources: DepegSource[];
  /** When this agent got the reading from Cournot (ISO). */
  fetchedAt: string;
  /** Cournot's request id when it sends one, as proof of the live call. */
  requestId: string | null;
}

export class CournotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CournotError";
  }
}

type Fetch = typeof fetch;

async function call(fetchFn: Fetch, operation: "resolve" | "probability", body: unknown, apiKey?: string) {
  let response: Response;
  try {
    response = await fetchFn(`${COURNOT_ORIGIN}/intelligence/v1/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "COURNOT-API-KEY": apiKey } : {}) },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(operation === "probability" ? 120_000 : 30_000),
    });
  } catch {
    throw new CournotError("Cournot couldn't be reached.");
  }
  if (response.status === 402) throw new CournotError("Cournot asks for payment (HTTP 402): the free quota is used up and no credited COURNOT_API_KEY is set.");
  if (!response.ok) throw new CournotError(`Cournot answered HTTP ${response.status}.`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CournotError("Cournot sent an unreadable answer.");
  }
  if (!isRecord(payload)) throw new CournotError("Cournot sent an unreadable answer.");
  if (payload.code === 22002) throw new CournotError("Cournot credits are used up.");
  if (payload.code !== 0 || !isRecord(payload.data)) {
    throw new CournotError(`Cournot refused ${operation} (code ${typeof payload.code === "number" ? payload.code : "unknown"}).`);
  }
  const requestId =
    response.headers.get("x-request-id") ?? stringOrNull(payload.request_id) ?? stringOrNull(payload.data.request_id);
  return { data: payload.data, requestId };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The one active "USDC depeg by December 31?" YES market, as A's check requires. */
function pickMarket(data: Record<string, unknown>, now: Date): { id: string; title: string } {
  const markets = Array.isArray(data.markets) ? data.markets : [];
  const matches = markets
    .map((entry) => (isRecord(entry) && isRecord(entry.market_info) ? entry.market_info : null))
    .filter((market): market is Record<string, unknown> => {
      if (!market) return false;
      const description = typeof market.description === "string" ? market.description.toLowerCase() : "";
      return (
        market.title === MARKET_TITLE &&
        market.market_outcome === "YES" &&
        description.includes("24-hour period") &&
        description.includes("below 98 cents")
      );
    });
  if (matches.length !== 1) throw new CournotError("Cournot didn't identify one unique USDC depeg market.");
  const [market] = matches as [Record<string, unknown>];
  const id = String(market.id ?? "");
  if (!/^\d+$/.test(id)) throw new CournotError("Cournot's market id isn't valid.");
  const end = typeof market.end_time === "string" ? Date.parse(market.end_time) : Number.NaN;
  if (!Number.isFinite(end)) throw new CournotError("Cournot's market has no end time.");
  if (end <= now.getTime()) throw new CournotError("The USDC depeg market has ended; pick an active Cournot market.");
  return { id, title: MARKET_TITLE };
}

/** Sources from the basis, which is either a list of sources or an anchor plus cross-checks. */
export function sourcesIn(basis: unknown, found: DepegSource[] = []): DepegSource[] {
  if (Array.isArray(basis)) {
    for (const item of basis) sourcesIn(item, found);
  } else if (isRecord(basis)) {
    const title = stringOrNull(basis.source);
    if (title && !/[\p{C}]/u.test(title)) {
      const source: DepegSource = { title: title.slice(0, 200) };
      const url = stringOrNull(basis.url);
      if (url) {
        try {
          const parsed = new URL(url);
          if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password) source.url = parsed.toString();
        } catch {
          // not a usable link: keep the title only
        }
      }
      const time = stringOrNull(basis.time);
      if (time && Number.isFinite(Date.parse(time))) source.time = new Date(Date.parse(time)).toISOString();
      if (!found.some((s) => s.title === source.title && s.url === source.url)) found.push(source);
    }
    for (const value of Object.values(basis)) if (typeof value === "object") sourcesIn(value, found);
  }
  return found;
}

export async function readDepeg(options: { fetch?: Fetch; apiKey?: string; now?: () => Date } = {}): Promise<DepegReading> {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const resolved = await call(fetchFn, "resolve", { message: DEPEG_QUESTION, limit: 5 });
  const market = pickMarket(resolved.data, now());

  const assessed = await call(fetchFn, "probability", { message: DEPEG_QUESTION, market_ids: [market.id] }, options.apiKey);
  const data = assessed.data;
  if (Array.isArray(data.markets)) {
    const ids = data.markets.map((m) => (isRecord(m) && isRecord(m.market_info) ? String(m.market_info.id) : null));
    if (ids.length !== 1 || ids[0] !== market.id) throw new CournotError("Cournot's answer is about a different market.");
  }
  // Today the API returns a number; richer assessments put it under result.point_estimate.
  const assessment = isRecord(data.probability) ? data.probability : data;
  const raw = isRecord(assessment.result) ? assessment.result.point_estimate : data.probability;
  const probability = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new CournotError("Cournot's probability is missing or out of range.");
  const sources = sourcesIn(assessment.basis ?? data.basis);
  if (sources.length === 0) throw new CournotError("Cournot gave no sources for this estimate.");

  return {
    claim: DEPEG_QUESTION,
    marketId: market.id,
    marketTitle: market.title,
    probability,
    sources,
    fetchedAt: now().toISOString(),
    requestId: assessed.requestId ?? resolved.requestId,
  };
}
