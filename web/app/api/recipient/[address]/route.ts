import { createPublicClient, http } from "viem";
import { FACTORY_ADDRESS, chain } from "@/lib/chain";
import { createRecipientHandler, events, type LogReader } from "@/lib/recipient-logs";

export const dynamic = "force-dynamic";

/** NodeReal's BSC testnet endpoint; the key stays on this server (never in the browser or a log line). */
function nodeRealReader(): LogReader | null {
  const key = process.env.NODEREAL_API_KEY;
  if (!key) return null;
  const client = createPublicClient({ chain, transport: http(`https://bsc-testnet.nodereal.io/v1/${key}`, { timeout: 20_000 }) });
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getVaultCreatedLogs: async (factory, fromBlock, toBlock) =>
      (await client.getLogs({ address: factory, event: events.VAULT_CREATED, fromBlock, toBlock })).map((log) => ({ vault: log.args.vault! })),
    getPaidLogs: async (recipient, fromBlock, toBlock) =>
      (await client.getLogs({ event: events.PAID, args: { recipient }, fromBlock, toBlock })).map((log) => ({
        address: log.address,
        token: log.args.token!,
        amount: log.args.amount!,
        ref: log.args.ref!,
        hash: log.transactionHash,
        block: log.blockNumber,
      })),
    getBlockTimestamp: async (blockNumber) => Number((await client.getBlock({ blockNumber })).timestamp),
  };
}

const handle = createRecipientHandler({ reader: nodeRealReader(), factory: FACTORY_ADDRESS });

export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  const { address } = await context.params;
  return handle(address);
}
