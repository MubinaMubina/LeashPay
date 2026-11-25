import { getAddress, isAddress, type Address } from "viem";
import type { OwnerResult } from "./session";

/**
 * The web server's only path to the agent. Every route the browser may use is a row in
 * ROUTES; anything else answers 404, so nothing is ever forwarded generically.
 *
 *   browser ─► /api/<route> ─► owner = session's Privy wallet ─► owner check ─► agent
 *                                (401/503 if none)              (403 if mismatched)
 *
 * Owner checks:
 * - The browser never needs to send an owner. If it sends one (query or body) that isn't
 *   the session owner, the request is refused with 403 and never forwarded.
 * - "owner" routes: the agent receives the session owner in the path, query or body.
 * - "plan" routes: the plan is looked up first; another owner's plan answers 403 and the
 *   guarded call (approval, execute, demo-attack) is never sent.
 *
 * Forwarding rules the agent's middleware requires (agent/src/app.ts): POSTs carry
 * content-type: application/json; the bearer token is added when AGENT_API_TOKEN is set;
 * requests go to the agent's own loopback URL, so the Host header is the agent's, never
 * the browser's. Browser headers and cookies are never passed on.
 */

export interface ProxyDeps {
  resolveOwner: (request: Request) => Promise<OwnerResult>;
  fetch: typeof fetch;
  /** The agent's base URL, such as http://127.0.0.1:8787. */
  agentUrl: string;
  agentToken?: string;
}

type OwnerCheck = "path" | "query" | "body" | "plan";

interface Route {
  method: "GET" | "POST";
  /** The path under /api/, with ":id" for a plan id. */
  web: readonly string[];
  agent: (input: { owner: Address; id: string }) => string;
  owner: OwnerCheck;
  /** Query parameters passed on to the agent unchanged. */
  passQuery?: readonly string[];
  timeoutMs: number;
}

export const ROUTES: readonly Route[] = [
  { method: "GET", web: ["vault"], agent: ({ owner }) => `/vaults/${owner}`, owner: "path", timeoutMs: 30_000 },
  { method: "GET", web: ["directory"], agent: ({ owner }) => `/directory?owner=${owner}`, owner: "query", timeoutMs: 15_000 },
  { method: "POST", web: ["directory"], agent: () => "/directory", owner: "body", timeoutMs: 15_000 },
  // Claude plans in up to a minute, and previews read the chain.
  { method: "POST", web: ["plans"], agent: () => "/plans", owner: "body", timeoutMs: 150_000 },
  { method: "GET", web: ["plans", ":id"], agent: ({ id }) => `/plans/${id}`, owner: "plan", timeoutMs: 15_000 },
  {
    method: "GET",
    web: ["plans", ":id", "approval"],
    agent: ({ id }) => `/plans/${id}/approval`,
    owner: "plan",
    passQuery: ["payEarly"],
    timeoutMs: 15_000,
  },
  // Each payment waits for finality, one after another.
  { method: "POST", web: ["plans", ":id", "execute"], agent: ({ id }) => `/plans/${id}/execute`, owner: "plan", timeoutMs: 300_000 },
  { method: "POST", web: ["plans", ":id", "attack"], agent: ({ id }) => `/plans/${id}/demo-attack`, owner: "plan", timeoutMs: 120_000 },
];

const PLAN_ID = /^[A-Za-z0-9-]{1,80}$/;
const MAX_BODY_BYTES = 32 * 1024;
const LOOKUP_TIMEOUT_MS = 15_000;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function match(method: string, segments: readonly string[]): { route: Route; id: string } | null {
  for (const route of ROUTES) {
    if (route.method !== method || route.web.length !== segments.length) continue;
    let id = "";
    const fits = route.web.every((part, i) => {
      if (part !== ":id") return part === segments[i];
      id = segments[i];
      return true;
    });
    if (fits) return { route, id };
  }
  return null;
}

/** An owner the browser sent anyway must be the session owner. */
function checkClaimedOwner(claimed: unknown, owner: Address): void {
  if (claimed === undefined || claimed === null || claimed === "") return;
  if (typeof claimed !== "string" || !isAddress(claimed, { strict: false })) {
    throw new Refusal(400, "owner must be a 0x address.");
  }
  if (getAddress(claimed) !== owner) throw new Refusal(403, "You can only act for your own vault.");
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new Refusal(413, "The request body is too large.");
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refusal(400, "Send the body as JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal(400, "Send a JSON object.");
  return value as Record<string, unknown>;
}

async function callAgent(deps: ProxyDeps, method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method === "POST") headers["content-type"] = "application/json";
  if (deps.agentToken) headers.authorization = `Bearer ${deps.agentToken}`;
  try {
    return await deps.fetch(new URL(path, deps.agentUrl), {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    // Connection refused, DNS failure or timeout: the page shows its "agent isn't running" banner.
    throw new Refusal(502, "agent unreachable");
  }
}

/** The agent's answer, passed through with its status and JSON body. */
async function relay(response: Response): Promise<Response> {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

export async function handleAgentRequest(request: Request, segments: readonly string[], deps: ProxyDeps): Promise<Response> {
  try {
    const found = match(request.method, segments);
    if (!found) return reply(404, { error: "Not found." });
    const { route, id } = found;
    if (route.web.includes(":id") && !PLAN_ID.test(id)) throw new Refusal(400, "That plan id isn't valid.");

    const session = await deps.resolveOwner(request);
    if (!session.ok) return reply(session.status, { error: session.error });
    const { owner } = session;

    const url = new URL(request.url);
    checkClaimedOwner(url.searchParams.get("owner"), owner);
    const body = route.method === "POST" ? await readJsonBody(request) : undefined;
    if (body) {
      checkClaimedOwner(body.owner, owner);
      delete body.owner;
    }

    let path = route.agent({ owner, id });
    if (route.passQuery) {
      const passed = new URLSearchParams();
      for (const key of route.passQuery) {
        const value = url.searchParams.get(key);
        if (value !== null) passed.set(key, value);
      }
      if ([...passed].length > 0) path += `?${passed}`;
    }

    if (route.owner === "plan") {
      const lookup = await callAgent(deps, "GET", `/plans/${id}`, undefined, LOOKUP_TIMEOUT_MS);
      if (!lookup.ok) return relay(lookup);
      const found = (await lookup.json()) as { plan?: { owner?: string } };
      const planOwner = found.plan?.owner;
      if (typeof planOwner !== "string" || !isAddress(planOwner, { strict: false }) || getAddress(planOwner) !== owner) {
        throw new Refusal(403, "You can only act for your own vault.");
      }
      // The lookup was the request itself: answer with it instead of asking twice.
      if (route.method === "GET" && route.web.length === 2) return reply(200, found);
    }

    const forwarded = route.owner === "body" ? { ...body, owner } : body;
    return relay(await callAgent(deps, route.method, path, forwarded, route.timeoutMs));
  } catch (err) {
    if (err instanceof Refusal) return reply(err.status, { error: err.message });
    throw err;
  }
}
