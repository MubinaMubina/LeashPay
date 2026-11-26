import { VAULT_FACTORIES } from "@/lib/chain";
import { nodeRealReader } from "@/lib/node-real-reader";
import { createHistoryHandler } from "@/lib/payment-history";
import { proxyDeps } from "@/lib/server";

export const dynamic = "force-dynamic";
export const GET = createHistoryHandler({
  factory: VAULT_FACTORIES, reader: nodeRealReader(), resolveOwner: request => proxyDeps().resolveOwner(request),
});
