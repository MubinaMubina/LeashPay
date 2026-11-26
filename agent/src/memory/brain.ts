/**
 * ChatAndBuild Living Brain: the agent's long-term memory. A capture is a note the agent saves;
 * Living Brain compiles captures into pages that a search finds later. Same endpoints as
 * Builder A's terminal check (scripts/demo_identity.py).
 */

export const BRAIN_ORIGIN = "https://api.livingbrain.com";
/** One deadline per call: a plan waits on the search, so it must stay short. */
export const BRAIN_DEADLINE_MS = 8_000;

export class BrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainError";
  }
}

export interface BrainNote {
  label: string;
  content: string;
  /** A stable id for what the note is about, so the same event saved twice is recognisable. */
  originRef: string;
}

export interface SearchHit {
  pageId: string;
  slug: string;
}

/** A capture the agent saved, as Living Brain stores it: the agent's own words, not a compiled page. */
export interface BrainSource {
  id: string;
  originRef: string;
  label?: string;
  content: string;
  status?: string;
  /** The compiled pages this capture went into, so search hits can rank it. */
  affectedPageIds: string[];
  /** ms since epoch, when Living Brain gives a readable time. */
  createdAt?: number;
}

export interface BrainClient {
  capture(note: BrainNote): Promise<string>;
  search(query: string, topK: number): Promise<SearchHit[]>;
  /** One page of this brain and subject's captures. */
  sources(limit: number, offset: number): Promise<BrainSource[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const timedOut = (signal: AbortSignal) => signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";

export function createBrainClient(options: {
  apiKey: string;
  brainId: string;
  subjectId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): BrainClient {
  const fetchFn = options.fetch ?? fetch;
  const ms = options.timeoutMs ?? BRAIN_DEADLINE_MS;
  const base = `${BRAIN_ORIGIN}/v1/brains/${encodeURIComponent(options.brainId)}`;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(ms);
    const unreachable = () => new BrainError(timedOut(signal) ? `Living Brain didn't answer within ${ms / 1000} s.` : "Living Brain couldn't be reached.");
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          "x-api-key": options.apiKey,
          "x-subject-id": options.subjectId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch {
      throw unreachable();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 402) throw new BrainError("Living Brain's prepaid memory balance is empty (HTTP 402), so it saves nothing new until the project is topped up.");
      if (response.status === 401 || response.status === 403) throw new BrainError(`Living Brain refused the key (HTTP ${response.status}). Check LIVING_BRAIN_API_KEY.`);
      throw new BrainError(`Living Brain answered HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      if (signal.aborted) throw unreachable();
      throw new BrainError("Living Brain sent an unreadable answer.");
    }
  }

  return {
    async capture(note) {
      const saved = await call("POST", "/captures", { kind: "note", bucket: "notes", ...note });
      if (!isRecord(saved) || !nonEmpty(saved.id)) throw new BrainError("Living Brain didn't confirm the saved note.");
      return saved.id;
    },
    async search(query, topK) {
      const hits = await call("POST", "/search", { query, topK });
      if (!Array.isArray(hits)) throw new BrainError("Living Brain sent an unreadable search answer.");
      return hits.flatMap((h) => (isRecord(h) && nonEmpty(h.pageId) && nonEmpty(h.slug) ? [{ pageId: h.pageId, slug: h.slug }] : []));
    },
    async sources(limit, offset) {
      const feed = await call("GET", `/sources?limit=${limit}&offset=${offset}`);
      if (!isRecord(feed) || !Array.isArray(feed.items)) throw new BrainError("Living Brain sent an unreadable list of saved notes.");
      // Anything not from this brain and subject, or missing what recall checks, is not this agent's memory.
      return feed.items.flatMap((row): BrainSource[] => {
        if (!isRecord(row) || !nonEmpty(row.id) || !nonEmpty(row.originRef) || typeof row.content !== "string") return [];
        if (row.brainId !== options.brainId || row.subjectId !== options.subjectId) return [];
        const created = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number.NaN;
        return [
          {
            id: row.id,
            originRef: row.originRef,
            content: row.content,
            ...(nonEmpty(row.label) ? { label: row.label } : {}),
            ...(typeof row.status === "string" ? { status: row.status } : {}),
            affectedPageIds: Array.isArray(row.affectedPageIds) ? row.affectedPageIds.filter(nonEmpty) : [],
            ...(Number.isFinite(created) ? { createdAt: created } : {}),
          },
        ];
      });
    },
  };
}
