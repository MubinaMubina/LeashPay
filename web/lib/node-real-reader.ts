import { createPublicClient, http, parseAbiItem } from "viem";
import { leashVaultFactoryAbi } from "./abi.generated";
import { chain } from "./chain";
import { events } from "./recipient-logs";
import { sentPaymentsWithFees, type HistoryReader, type PaidLog } from "./payment-history";

const feeCharged = parseAbiItem("event PaymentFeeCharged(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed ref)");

/** Server-only. RPC failures can contain the URL, so route handlers return sanitized errors. */
export function nodeRealReader(): HistoryReader | null {
  const key = process.env.NODEREAL_API_KEY;
  if (!key) return null;
  const client = createPublicClient({ chain, transport: http(`https://bsc-testnet.nodereal.io/v1/${key}`, { timeout: 20_000 }) });
  return {
    getTokens: factory => client.readContract({ address: factory, abi: leashVaultFactoryAbi, functionName: "config" }),
    finalizedBlock: async () => (await client.getBlock({ blockTag: "finalized" })).number,
    getVaultCreatedLogs: async (factory, fromBlock, toBlock) =>
      (await client.getLogs({ address: factory, event: events.VAULT_CREATED, strict: true, fromBlock, toBlock })).map(log => log.args),
    getPaidLogs: async (recipient, fromBlock, toBlock) =>
      (await client.getLogs({ event: events.PAID, strict: true, fromBlock, toBlock, args: { recipient } })).map(log => ({
        ...log.args, address: log.address, hash: log.transactionHash, block: log.blockNumber, logIndex: log.logIndex,
      })),
    getSentLogs: async (address, fromBlock, toBlock) => {
      const logs = await client.getLogs({ address, events: [events.PAID, feeCharged], strict: true, fromBlock, toBlock });
      const payouts: PaidLog[] = [];
      const fees: PaidLog[] = [];
      for (const log of logs) {
        (log.eventName === "Paid" ? payouts : fees).push({
          ...log.args, address: log.address, hash: log.transactionHash, block: log.blockNumber, logIndex: log.logIndex,
        });
      }
      return sentPaymentsWithFees(payouts, fees);
    },
    getBlockTimestamp: async blockNumber => Number((await client.getBlock({ blockNumber })).timestamp),
  };
}
