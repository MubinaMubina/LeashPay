import { isAddress, type Address, type Hex } from "viem";
import { chunks, FACTORY_DEPLOY_BLOCK, limited } from "./recipient-logs";
import type { OwnerResult } from "./session";

export type HistoryFilter = "all" | "sent" | "received";
type Stablecoin = "USDT" | "USDC";
type Direction = "sent" | "received" | "self";

export interface PaidLog {
  address: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  ref: Hex;
  hash: Hex;
  block: bigint;
  logIndex: number;
}

export interface HistoryReader {
  finalizedBlock(): Promise<bigint>;
  getTokens(factory: Address): Promise<{ usdt: Address; usdc: Address }>;
  getVaultCreatedLogs(factory: Address, from: bigint, to: bigint): Promise<{ owner: Address; vault: Address }[]>;
  getPaidLogs(recipient: Address | Address[], from: bigint, to: bigint): Promise<PaidLog[]>;
  getSentLogs(vault: Address, from: bigint, to: bigint): Promise<PaidLog[]>;
  getBlockTimestamp(block: bigint): Promise<number>;
}

interface Payment {
  log: PaidLog;
  direction: Direction;
  symbol: Stablecoin;
  /** The other party's wallet and, if known, their LeashPay vault. */
  wallet: Address;
  vault?: Address;
  /** The actual destination for sent payments or emitting vault for received payments. */
  address: Address;
}

export interface HistoryItem {
  hash: Hex;
  logIndex: number;
  block: string;
  timestamp: number | null;
  direction: Direction;
  symbol: Stablecoin;
  amount: string;
  wallet: Address;
  address: Address;
  vault?: Address;
}

export interface HistoryPage {
  payments: HistoryItem[];
  next: string | null;
  count: number;
  totals: Record<"sent" | "received", Record<Stablecoin, string>>;
}

export async function ownerPayments(owner: Address, factory: Address, reader: HistoryReader): Promise<Payment[]> {
  const [head, tokens] = await Promise.all([reader.finalizedBlock(), reader.getTokens(factory)]);
  const tokenSymbols = new Map<string, Stablecoin>([[tokens.usdt.toLowerCase(), "USDT"], [tokens.usdc.toLowerCase(), "USDC"]]);
  const ranges = chunks(FACTORY_DEPLOY_BLOCK, head);
  const created = (await limited(ranges.map(([from, to]) => () => reader.getVaultCreatedLogs(factory, from, to)))).flat();
  const byVault = new Map(created.map(pair => [pair.vault.toLowerCase(), pair]));
  const byOwner = new Map(created.map(pair => [pair.owner.toLowerCase(), pair]));
  const me = owner.toLowerCase();
  const ownVault = byOwner.get(me)?.vault;
  const destinations = ownVault ? [owner, ownVault] : owner;
  const reads = ranges.flatMap(([from, to]) => {
    const incoming = () => reader.getPaidLogs(destinations, from, to);
    return ownVault ? [incoming, () => reader.getSentLogs(ownVault, from, to)] : [incoming];
  });
  const payments = new Map<string, Payment>();
  for (const log of (await limited(reads)).flat()) {
    const sender = byVault.get(log.address.toLowerCase());
    const symbol = tokenSymbols.get(log.token.toLowerCase());
    if (!sender || !symbol) continue;
    const target = log.recipient.toLowerCase();
    const recipient = byVault.get(target) ?? byOwner.get(target);
    const sent = sender.owner.toLowerCase() === me;
    const received = target === me || target === ownVault?.toLowerCase();
    if (!sent && !received) continue;
    const other = sent ? recipient : sender;
    payments.set(`${log.hash}:${log.logIndex}`, {
      log, symbol, direction: sent ? (received ? "self" : "sent") : "received",
      wallet: other?.owner ?? log.recipient, vault: other?.vault, address: sent ? log.recipient : log.address,
    });
  }
  return [...payments.values()].sort((a, b) => a.log.block === b.log.block
    ? b.log.logIndex - a.log.logIndex : a.log.block > b.log.block ? -1 : 1);
}

const PAGE_SIZE = 10;
export async function historyPage(payments: Payment[], filter: HistoryFilter, contact: string | null,
  before: string | null, reader: HistoryReader): Promise<HistoryPage> {
  const party = contact?.toLowerCase();
  const matches = payments.filter(p => !party || party === p.wallet.toLowerCase() || party === p.vault?.toLowerCase());
  const totals = { sent: { USDT: 0n, USDC: 0n }, received: { USDT: 0n, USDC: 0n } };
  for (const p of matches) {
    if (p.direction !== "received") totals.sent[p.symbol] += p.log.amount;
    if (p.direction !== "sent") totals.received[p.symbol] += p.log.amount;
  }
  const filtered = matches.filter(p => filter === "all" || p.direction === filter || p.direction === "self");
  const cursor = before?.split(".").map(BigInt);
  const remaining = cursor ? filtered.filter(({log}) => log.block < cursor[0] ||
    (log.block === cursor[0] && BigInt(log.logIndex) < cursor[1])) : filtered;
  const page = remaining.slice(0, PAGE_SIZE);
  const blocks = [...new Set(page.map(p => p.log.block))];
  const times = new Map(await limited(blocks.map(block => async () =>
    [block, await reader.getBlockTimestamp(block).catch(() => null)] as const)));
  const last = page.at(-1)?.log;
  return {
    payments: page.map(({ log, ...p }) => ({ ...p, hash: log.hash, logIndex: log.logIndex,
      amount: log.amount.toString(), block: log.block.toString(), timestamp: times.get(log.block) ?? null })),
    next: remaining.length > PAGE_SIZE && last ? `${last.block}.${last.logIndex}` : null,
    count: filtered.length,
    totals: {
      sent: { USDT: String(totals.sent.USDT), USDC: String(totals.sent.USDC) },
      received: { USDT: String(totals.received.USDT), USDC: String(totals.received.USDC) },
    },
  };
}

export function createHistoryHandler(deps: {
  factory: Address; reader: HistoryReader | null; resolveOwner: (request: Request) => Promise<OwnerResult>;
}) {
  const cache = new Map<string, { started: number; result: Promise<Payment[]> }>();
  const json = (status: number, data: unknown) => Response.json(data, { status, headers: { "cache-control": "private, no-store" } });
  return async (request: Request) => {
    const session = await deps.resolveOwner(request);
    if (!session.ok) return json(session.status, { error: session.error });
    const params = new URL(request.url).searchParams;
    const filter = params.get("filter") ?? "all";
    const contact = params.get("contact");
    const before = params.get("before");
    if ((filter !== "all" && filter !== "sent" && filter !== "received") ||
        (contact !== null && !isAddress(contact, { strict: false })) ||
        (before !== null && !/^\d{1,20}\.\d{1,10}$/.test(before))) return json(400, { error: "Invalid history filter or page." });
    if (!deps.reader) return json(503, { error: "The BSC testnet payment history service is not configured." });
    const key = session.owner.toLowerCase();
    let entry = cache.get(key);
    try {
      // A newly opened view asks for a fresh scan. Coalesce rapid filter changes and
      // reuse the snapshot for subsequent pages, whose cursor marks the last log seen.
      const reuseMs = !before && params.get("fresh") === "1" ? 2_000 : 30_000;
      if (!entry || Date.now() - entry.started >= reuseMs) {
        cache.delete(key);
        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        entry = { started: Date.now(), result: ownerPayments(session.owner, deps.factory, deps.reader) };
        cache.set(key, entry);
      }
      return json(200, await historyPage(await entry.result, filter, contact, before, deps.reader));
    } catch {
      if (cache.get(key) === entry) cache.delete(key);
      return json(502, { error: "Couldn’t load confirmed payments from BSC testnet. Try again." });
    }
  };
}
