import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { ROUTES, handleAgentRequest, type ProxyDeps } from "@/lib/agent-proxy";
import type { OwnerResult } from "@/lib/session";

const OWNER = getAddress("0x7f3a00000000000000000000000000000000c0de");
const STRANGER = getAddress("0x5eeccb731a3b642bfe93f0aabe95ac74f5126b21");
const AGENT_URL = "http://127.0.0.1:8787";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in agent: records every call and answers plan lookups for one owner. */
function fakeAgent(options: { planOwner?: Address; down?: boolean; token?: string; session?: OwnerResult } = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    if (options.down) throw new TypeError("fetch failed");
    const url = String(input);
    calls.push({
      method: init.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { pathname } = new URL(url);
    if (/^\/plans\/[^/]+$/.test(pathname)) {
      return Response.json({ plan: { id: "plan-1", owner: options.planOwner ?? OWNER }, events: [] });
    }
    return Response.json({ ok: true, path: pathname });
  }) as typeof globalThis.fetch;

  const deps: ProxyDeps = {
    resolveOwner: async () => options.session ?? { ok: true, owner: OWNER },
    fetch,
    agentUrl: AGENT_URL,
    agentToken: options.token,
  };
  return { calls, deps };
}

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000/api/${path}`, {
    method,
    headers: { authorization: "Bearer privy-access-token", cookie: "privy-token=abc", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const segments = (path: string) => path.split("?")[0].split("/");

async function send(agent: ReturnType<typeof fakeAgent>, method: string, path: string, body?: unknown) {
  const response = await handleAgentRequest(request(method, path, body), segments(path), agent.deps);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("route table", () => {
  it("only forwards the owner's vault, directory, chat and plan routes", () => {
    expect(ROUTES.map((r) => `${r.method} /api/${r.web.join("/")}`)).toEqual([
      "GET /api/vault",
      "GET /api/directory",
      "POST /api/directory",
      "POST /api/chat",
      "POST /api/plans",
      "GET /api/plans/:id",
      "GET /api/plans/:id/approval",
      "POST /api/plans/:id/execute",
      "POST /api/plans/:id/attack",
    ]);
  });

  it("answers 404 for any other path or method and never calls the agent", async () => {
    for (const [method, path] of [
      ["GET", "health"],
      ["POST", "vault"],
      ["GET", "vaults/0xabc"],
      ["POST", "plans/plan-1/demo-attack"],
      ["GET", "plans/plan-1/approval/extra"],
    ]) {
      const agent = fakeAgent();
      expect((await send(agent, method, path)).status, `${method} ${path}`).toBe(404);
      expect(agent.calls).toEqual([]);
    }
  });
});

describe("owner-taking routes", () => {
  const cases = [
    { method: "GET", path: "vault", expectUrl: `${AGENT_URL}/vaults/${OWNER}` },
    { method: "GET", path: "directory", expectUrl: `${AGENT_URL}/directory?owner=${OWNER}` },
    { method: "POST", path: "directory", body: { name: "Mai", address: STRANGER }, expectBodyOwner: true },
    { method: "POST", path: "chat", body: { message: "25 USDT", context: ["Pay Linh"] }, expectBodyOwner: true },
    { method: "POST", path: "plans", body: { message: "Pay Linh 1" }, expectBodyOwner: true },
  ] as const;

  for (const c of cases) {
    it(`${c.method} /api/${c.path}: the agent receives the session owner`, async () => {
      const agent = fakeAgent();
      const { status } = await send(agent, c.method, c.path, "body" in c ? c.body : undefined);
      expect(status).toBe(200);
      expect(agent.calls).toHaveLength(1);
      if ("expectUrl" in c) expect(agent.calls[0].url).toBe(c.expectUrl);
      if ("expectBodyOwner" in c) expect(agent.calls[0].body).toMatchObject({ ...c.body, owner: OWNER });
    });

    it(`${c.method} /api/${c.path}: another owner is refused with 403 and the agent receives nothing`, async () => {
      const agent = fakeAgent();
      const viaQuery = await send(agent, c.method, `${c.path}?owner=${STRANGER}`, "body" in c ? c.body : undefined);
      expect(viaQuery.status).toBe(403);
      if (c.method === "POST") {
        const viaBody = await send(agent, c.method, c.path, { ...c.body, owner: STRANGER });
        expect(viaBody.status).toBe(403);
      }
      expect(agent.calls).toEqual([]);
    });
  }

  it("accepts the session owner written in any letter case", async () => {
    const agent = fakeAgent();
    expect((await send(agent, "POST", "plans", { message: "x", owner: OWNER.toLowerCase() })).status).toBe(200);
    expect(agent.calls[0].body).toMatchObject({ owner: OWNER });
  });

  it("answers 400 for an owner that isn't an address", async () => {
    const agent = fakeAgent();
    expect((await send(agent, "POST", "plans", { message: "x", owner: "alice" })).status).toBe(400);
    expect(agent.calls).toEqual([]);
  });
});

describe("plan-id routes", () => {
  const cases = [
    { method: "GET", path: "plans/plan-1", guarded: null },
    { method: "GET", path: "plans/plan-1/approval", guarded: "/plans/plan-1/approval" },
    { method: "POST", path: "plans/plan-1/execute", guarded: "/plans/plan-1/execute", body: { expires: "x", signature: "0x", payEarly: false } },
    { method: "POST", path: "plans/plan-1/attack", guarded: "/plans/plan-1/demo-attack" },
  ] as const;

  for (const c of cases) {
    it(`${c.method} /api/${c.path}: the owner's own plan is forwarded`, async () => {
      const agent = fakeAgent();
      expect((await send(agent, c.method, c.path, "body" in c ? c.body : undefined)).status).toBe(200);
      const paths = agent.calls.map((call) => new URL(call.url).pathname);
      expect(paths).toEqual(c.guarded ? ["/plans/plan-1", c.guarded] : ["/plans/plan-1"]);
    });

    it(`${c.method} /api/${c.path}: another owner's plan gets 403 after only the lookup`, async () => {
      const agent = fakeAgent({ planOwner: STRANGER });
      expect((await send(agent, c.method, c.path, "body" in c ? c.body : undefined)).status).toBe(403);
      expect(agent.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["GET /plans/plan-1"]);
    });
  }

  it("passes payEarly to the approval route and nothing else", async () => {
    const agent = fakeAgent();
    await send(agent, "GET", "plans/plan-1/approval?payEarly=true&owner=");
    expect(agent.calls[1].url).toBe(`${AGENT_URL}/plans/plan-1/approval?payEarly=true`);
  });

  it("answers 400 for a malformed plan id without calling the agent", async () => {
    const agent = fakeAgent();
    expect((await send(agent, "GET", "plans/..%2Fvaults")).status).toBe(400);
    expect(agent.calls).toEqual([]);
  });
});

describe("sessions and failures", () => {
  it("passes the session's refusal on (401 wallet not ready) without calling the agent", async () => {
    const agent = fakeAgent({ session: { ok: false, status: 401, error: "wallet not ready, try again" } });
    expect(await send(agent, "GET", "vault")).toEqual({ status: 401, json: { error: "wallet not ready, try again" } });
    expect(agent.calls).toEqual([]);
  });

  it("answers 502 agent unreachable when the agent isn't running", async () => {
    const agent = fakeAgent({ down: true });
    expect(await send(agent, "GET", "vault")).toEqual({ status: 502, json: { error: "agent unreachable" } });
  });
});

describe("forwarding rules the agent requires", () => {
  it("sends JSON on POST, never passes on the browser's login token or cookies, and adds the agent token when set", async () => {
    const withToken = fakeAgent({ token: "agent-token-0123456789" });
    await send(withToken, "POST", "plans", { message: "x" });
    expect(withToken.calls[0].headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer agent-token-0123456789",
    });

    const withoutToken = fakeAgent();
    await send(withoutToken, "GET", "vault");
    expect(withoutToken.calls[0].headers).toEqual({ accept: "application/json" });
  });
});
