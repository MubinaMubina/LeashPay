import { FACTORY_ADDRESS } from "@/lib/chain";
import { nodeRealReader } from "@/lib/node-real-reader";
import { createHistoryHandler } from "@/lib/payment-history";
import { proxyDeps } from "@/lib/server";

export const dynamic = "force-dynamic";
export const GET = createHistoryHandler({
  factory: FACTORY_ADDRESS, reader: nodeRealReader(), resolveOwner: request => proxyDeps().resolveOwner(request),
});
