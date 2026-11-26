import { FACTORY_ADDRESS } from "@/lib/chain";
import { createRecipientHandler } from "@/lib/recipient-logs";
import { nodeRealReader } from "@/lib/node-real-reader";

export const dynamic = "force-dynamic";

const handle = createRecipientHandler({ reader: nodeRealReader(), factory: FACTORY_ADDRESS });

export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;
  return handle(address);
}
