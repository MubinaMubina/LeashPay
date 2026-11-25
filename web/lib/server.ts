import { PrivyClient } from "@privy-io/node";
import type { ProxyDeps } from "./agent-proxy";
import { createOwnerResolver, type PrivyLookups } from "./session";

// Server-only wiring: the Privy secret and the agent token are read here and never
// reach the browser (next.config.ts loads them from the root .env).

let deps: ProxyDeps | undefined;

function privyLookups(): PrivyLookups | null {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return null;
  const client = new PrivyClient({ appId, appSecret });
  return {
    verifyAccessToken: (token) => client.utils().auth().verifyAccessToken(token),
    getUser: async (userId) => client.users()._get(userId),
  };
}

export function proxyDeps(): ProxyDeps {
  deps ??= {
    resolveOwner: createOwnerResolver(privyLookups()),
    fetch: globalThis.fetch.bind(globalThis),
    agentUrl: process.env.AGENT_URL || "http://127.0.0.1:8787",
    agentToken: process.env.AGENT_API_TOKEN || undefined,
  };
  return deps;
}
