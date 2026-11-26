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

export interface BrainPage {
  id: string;
  title: string;
  /** title, summary and body joined: what the agent can read. */
  text: string;
}

export interface BrainClient {
  capture(note: BrainNote): Promise<string>;
  search(query: string, topK: number): Promise<SearchHit[]>;
  page(slug: string): Promise<BrainPage>;
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
    async page(slug) {
      const page = await call("GET", `/pages/${encodeURIComponent(slug)}`);
      // A page from another brain or subject is not this agent's memory.
      if (!isRecord(page) || !nonEmpty(page.id) || page.brainId !== options.brainId || page.subjectId !== options.subjectId) {
        throw new BrainError("Living Brain returned a page that isn't from this brain.");
      }
      const parts = [page.title, page.summary, page.body].filter(nonEmpty);
      return { id: page.id, title: nonEmpty(page.title) ? page.title : slug, text: parts.join("\n") };
    },
  };
}
