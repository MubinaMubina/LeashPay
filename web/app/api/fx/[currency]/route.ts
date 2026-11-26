import { createFxHandler } from "@/lib/fx";

export const dynamic = "force-dynamic";

// The key stays on this server (next.config.ts copies CMC_API_KEY from the root .env).
const handle = createFxHandler({ apiKey: process.env.CMC_API_KEY });

export async function GET(_request: Request, context: { params: Promise<{ currency: string }> }) {
  const { currency } = await context.params;
  return handle(currency);
}
