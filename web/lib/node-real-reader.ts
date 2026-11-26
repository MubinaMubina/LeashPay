import { createPublicClient, http, type Address } from "viem";
import { leashVaultFactoryAbi } from "./abi.generated";
import { chain } from "./chain";
import { events, type LogReader } from "./recipient-logs";
import type { HistoryReader, PaidLog } from "./payment-history";

/** Server-only. RPC failures can contain the URL, so route handlers return sanitized errors. */
export function nodeRealReader(): (HistoryReader & LogReader) | null {
  const key = process.env.NODEREAL_API_KEY;
  if (!key) return null;
  const client = createPublicClient({ chain, transport: http(`https://bsc-testnet.nodereal.io/v1/${key}`, { timeout: 20_000 }) });
  const paid = async (fromBlock: bigint, toBlock: bigint, filter: { address: Address } | { args: { recipient: Address | Address[] } }): Promise<PaidLog[]> =>
    (await client.getLogs({ event: events.PAID, strict: true, fromBlock, toBlock, ...filter })).map(log => ({
      ...log.args, address: log.address, hash: log.transactionHash, block: log.blockNumber, logIndex: log.logIndex,
    }));
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getTokens: factory => client.readContract({ address: factory, abi: leashVaultFactoryAbi, functionName: "config" }),
    finalizedBlock: async () => (await client.getBlock({ blockTag: "finalized" })).number,
    getVaultCreatedLogs: async (factory, fromBlock, toBlock) =>
      (await client.getLogs({ address: factory, event: events.VAULT_CREATED, strict: true, fromBlock, toBlock })).map(log => log.args),
    getPaidLogs: (recipient, from, to) => paid(from, to, { args: { recipient } }),
    getSentLogs: (vault, from, to) => paid(from, to, { address: vault }),
    getBlockTimestamp: async blockNumber => Number((await client.getBlock({ blockNumber })).timestamp),
  };
}
