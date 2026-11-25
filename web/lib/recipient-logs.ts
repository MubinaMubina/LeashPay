import { getAddress, isAddress, parseAbiItem, type Address, type Hex } from "viem";

/**
 * Payments received by one address, from every LeashPay vault (D8, D21). The public BSC
 * testnet RPC refuses log searches, so this runs on the server through NodeReal:
 *
 *   VaultCreated logs from the factory ─► the set of real vaults
 *   Paid logs by recipient topic (any address) ─► keep only those emitted by a real vault
 *
 * Both searches start at the factory's deploy block and run in 50,000-block chunks.
 */

/** Block of the factory's deployment tx 0x00b11fd5…cfb8a (contracts/deployments/97.json has no block numbers). */
export const FACTORY_DEPLOY_BLOCK = 144_816_229n;
const CHUNK_BLOCKS = 50_000n;
const CONCURRENCY = 4;
const CACHE_MS = 30_000;
/** Block timestamps are looked up for at most this many payments (the newest). */
const MAX_LISTED = 50;

const VAULT_CREATED = parseAbiItem("event VaultCreated(address indexed owner, address indexed vault, address indexed agent)");
const PAID = parseAbiItem("event Paid(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed ref)");

export interface ReceivedPayment {
  vault: Address;
  token: Address;
  amount: string;
  ref: Hex;
  hash: Hex;
  block: string;
  /** Seconds since 1970, from the block. */
  timestamp: number | null;
}

/** The chain reads this needs, so tests can stand in for NodeReal. */
export interface LogReader {
  getBlockNumber(): Promise<bigint>;
  getVaultCreatedLogs(factory: Address, fromBlock: bigint, toBlock: bigint): Promise<{ vault: Address }[]>;
  getPaidLogs(
    recipient: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<{ address: Address; token: Address; amount: bigint; ref: Hex; hash: Hex; block: bigint }[]>;
  getBlockTimestamp(block: bigint): Promise<number>;
}

/** [from, to] ranges of at most CHUNK_BLOCKS blocks covering from..to. */
export function chunks(from: bigint, to: bigint, size = CHUNK_BLOCKS): [bigint, bigint][] {
  const ranges: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    ranges.push([start, end < to ? end : to]);
  }
  return ranges;
}

/** Runs the tasks at most `limit` at a time, keeping their order. */
async function limited<T>(tasks: (() => Promise<T>)[], limit = CONCURRENCY): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function paymentsTo(recipient: Address, factory: Address, reader: LogReader): Promise<ReceivedPayment[]> {
  const head = await reader.getBlockNumber();
  const ranges = chunks(FACTORY_DEPLOY_BLOCK, head);
  const [created, paid] = await Promise.all([
    limited(ranges.map(([from, to]) => () => reader.getVaultCreatedLogs(factory, from, to))),
    limited(ranges.map(([from, to]) => () => reader.getPaidLogs(recipient, from, to))),
  ]);
  const vaults = new Set(created.flat().map((log) => log.vault.toLowerCase()));
  // Paid is a public event signature: only events emitted by a vault the factory created count.
  const real = paid
    .flat()
    .filter((log) => vaults.has(log.address.toLowerCase()))
    .sort((a, b) => (a.block === b.block ? 0 : a.block > b.block ? -1 : 1))
    .slice(0, MAX_LISTED);

  const blocks = [...new Set(real.map((log) => log.block))];
  const times = new Map(
    await limited(blocks.map((block) => async () => [block, await reader.getBlockTimestamp(block).catch(() => null)] as const)),
  );
  return real.map((log) => ({
    vault: getAddress(log.address),
    token: getAddress(log.token),
    amount: log.amount.toString(),
    ref: log.ref,
    hash: log.hash,
    block: log.block.toString(),
    timestamp: times.get(log.block) ?? null,
  }));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * GET /api/recipient/:address. Public and read-only: it never calls the agent. An error is
 * an error state, never an empty list, so a recipient is never told "no payments" by mistake.
 */
export function createRecipientHandler(deps: { reader: LogReader | null; factory: Address; now?: () => number }) {
  const cache = new Map<string, { until: number; payments: ReceivedPayment[] }>();
  const now = deps.now ?? Date.now;
  return async (address: string): Promise<Response> => {
    if (!isAddress(address, { strict: false })) return json(400, { error: "That isn't a 0x address." });
    if (!deps.reader) return json(503, { error: "The web server needs NODEREAL_API_KEY in .env to look up payments." });
    const recipient = getAddress(address);
    const hit = cache.get(recipient);
    if (hit && hit.until > now()) return json(200, { recipient, payments: hit.payments });
    try {
      const payments = await paymentsTo(recipient, deps.factory, deps.reader);
      cache.set(recipient, { until: now() + CACHE_MS, payments });
      return json(200, { recipient, payments });
    } catch {
      // Never echo the error: viem messages include the RPC URL, and NodeReal's carries the key.
      return json(502, { error: "Couldn't reach BSC testnet. Try again." });
    }
  };
}

export const events = { VAULT_CREATED, PAID };
