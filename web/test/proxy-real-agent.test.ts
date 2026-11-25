import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleAgentRequest, type ProxyDeps } from "@/lib/agent-proxy";
// The real agent app, its middleware and its storage: only the chain is faked.
import { createApp } from "../../agent/src/app";
import { localHostHeaders } from "../../agent/src/config";
import { Executor } from "../../agent/src/execution/executor";
import { Journal } from "../../agent/src/execution/journal";
import { RecipientDirectory } from "../../agent/src/plan/directory";
import { FakeGateway, LINH, OWNER, tempDir } from "../../agent/test/fakes";

const TOKEN = "agent-api-token-for-tests-0123456789";
let server: Server;
let port: number;

/** Serve the agent over real HTTP, so Host, content-type and the bearer token are checked for real. */
beforeAll(async () => {
  const dataDir = tempDir();
  const gateway = new FakeGateway();
  const journal = new Journal(path.join(dataDir, "journal.jsonl"));
  let app: ReturnType<typeof createApp> | undefined;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const response = await app!.fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  app = createApp({
    gateway,
    planner: (async () => {
      throw new Error("not used");
    }) as never,
    directory: new RecipientDirectory(path.join(dataDir, "recipients.json")),
    journal,
    executor: new Executor({ gateway, journal }),
    apiToken: TOKEN,
    allowedHosts: localHostHeaders({ AGENT_HOST: "127.0.0.1", PORT: port }),
  });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const proxy = (agentToken?: string): ProxyDeps => ({
  resolveOwner: async () => ({ ok: true, owner: OWNER }),
  fetch: globalThis.fetch.bind(globalThis),
  agentUrl: `http://127.0.0.1:${port}`,
  agentToken,
});

const call = (deps: ProxyDeps, method: string, route: string, body?: unknown) =>
  handleAgentRequest(
    new Request(`http://localhost:3000/api/${route}`, {
      method,
      headers: { authorization: "Bearer privy-access-token", host: "localhost:3000" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    route.split("/"),
    deps,
  );

describe("proxy against the real agent app", () => {
  it("passes the agent's checks: JSON body, bearer token and the agent's own Host", async () => {
    const created = await call(proxy(TOKEN), "POST", "directory", { name: "Linh", address: LINH });
    expect(created.status).toBe(201);

    const listed = await call(proxy(TOKEN), "GET", "directory");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([{ name: "Linh", address: LINH }]);
  });

  it("is refused by the agent when the token is missing, so the token rule is real", async () => {
    expect((await call(proxy(undefined), "GET", "directory")).status).toBe(401);
  });
});
