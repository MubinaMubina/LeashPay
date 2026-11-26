import { handleAgentRequest } from "@/lib/agent-proxy";
import { proxyDeps } from "@/lib/server";

// Every /api/* request that reaches the agent goes through the route table in
// lib/agent-proxy.ts; paths not in that table answer 404. More specific routes
// (such as /api/recipient/[address]) are matched before this catch-all.
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  return handleAgentRequest(request, path, proxyDeps());
}

export { handle as GET, handle as POST };
