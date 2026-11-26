import { isAddress, type Address, type Hex } from "viem";
import {
  chunks, FACTORY_DEPLOY_BLOCK, limited, logAddressFilter, newestReceiptFirst, receiptId,
  type AddressFilter, type LogReader, type ReceiptLog,
} from "./recipient-logs";
import type { OwnerResult } from "./session";

export type HistoryFilter = "all" | "sent" | "received";
type Stablecoin = "USDT" | "USDC";
type Direction = "sent" | "received" | "self";

export interface PaidLog extends ReceiptLog {
  recipient: Address;
  fee?: { token: Address; amount: bigint };
}

/** Both events belong to the same payout, even if a transaction contains several payouts. */
export function sentPaymentsWithFees(payments: PaidLog[], charges: PaidLog[]): PaidLog[] {
  const key = (log: PaidLog) => [log.address, log.hash, log.ref, log.recipient].join(":").toLowerCase();
  const fees = new Map(charges.map(charge => [key(charge), { token: charge.token, amount: charge.amount }]));
  return payments.map(payment => ({ ...payment, fee: fees.get(key(payment)) }));
}

export interface HistoryReader extends LogReader {
  getTokens(factory: Address): Promise<{ usdt: Address; usdc: Address }>;
  getVaultCreatedLogs(factories: AddressFilter, from: bigint, to: bigint): Promise<{ owner: Address; vault: Address }[]>;
  getPaidLogs(recipient: AddressFilter, from: bigint, to: bigint): Promise<PaidLog[]>;
  getSentLogs(vaults: AddressFilter, from: bigint, to: bigint): Promise<PaidLog[]>;
}

interface Party {
  wallet: Address;
  vaults: Address[];
}

interface Payment {
  log: PaidLog;
  direction: Direction;
  symbol: Stablecoin;
  fee?: { amount: string; symbol: "USDT" };
  /** All of a contact's factory-issued vault addresses identify the same wallet in the contact filter. */
  party: Party;
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
  fee?: { amount: string; symbol: "USDT" };
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

export async function ownerPayments(owner: Address, factories: Address | readonly Address[], reader: HistoryReader): Promise<Payment[]> {
  const trusted = logAddressFilter(factories);
  // The canonical V2/V1 pair uses the same stablecoins. Custom deployments use only their configured factory.
  const active = typeof trusted === "string" ? trusted : trusted[0];
  const [head, tokens] = await Promise.all([reader.finalizedBlock(), reader.getTokens(active)]);
  const tokenSymbols = new Map<string, Stablecoin>([[tokens.usdt.toLowerCase(), "USDT"], [tokens.usdc.toLowerCase(), "USDC"]]);
  const ranges = chunks(FACTORY_DEPLOY_BLOCK, head);
  const created = (await limited(ranges.map(([from, to]) => () => reader.getVaultCreatedLogs(trusted, from, to)))).flat();
  const byOwner = new Map<string, Party>();
  const byVault = new Map<string, Party>();
  for (const { owner: wallet, vault } of created) {
    const key = wallet.toLowerCase();
    const vaultKey = vault.toLowerCase();
    if (byVault.has(vaultKey)) continue;
    const party = byOwner.get(key) ?? { wallet, vaults: [] };
    party.vaults.push(vault);
    byOwner.set(key, party);
    byVault.set(vaultKey, party);
  }
  const me = owner.toLowerCase();
  const ownVaults = byOwner.get(me)?.vaults ?? [];
  const senders = ownVaults.length ? logAddressFilter(ownVaults) : null;
  const destinations = logAddressFilter([owner, ...ownVaults]);
  const reads = ranges.flatMap(([from, to]) => {
    const incoming = () => reader.getPaidLogs(destinations, from, to);
    return senders ? [incoming, () => reader.getSentLogs(senders, from, to)] : [incoming];
  });
  const payments = new Map<string, Payment>();
  for (const log of (await limited(reads)).flat()) {
    const sender = byVault.get(log.address.toLowerCase());
    const symbol = tokenSymbols.get(log.token.toLowerCase());
    if (!sender || !symbol) continue;
    const target = log.recipient.toLowerCase();
    const targetVaultOwner = byVault.get(target);
    const recipient = targetVaultOwner ?? byOwner.get(target);
    const sent = sender.wallet.toLowerCase() === me;
    const received = target === me || targetVaultOwner?.wallet.toLowerCase() === me;
    if (!sent && !received) continue;
    const party = sent ? recipient ?? { wallet: log.recipient, vaults: [] } : sender;
    const destinationVault = targetVaultOwner ? log.recipient : recipient?.vaults.length === 1 ? recipient.vaults[0] : undefined;
    const id = receiptId(log);
    // A self-payment also matches the incoming query, which has no fee event attached.
    if (payments.has(id) && !log.fee) continue;
    payments.set(id, {
      log, symbol, direction: sent ? (received ? "self" : "sent") : "received",
      ...(sent && log.fee?.token.toLowerCase() === tokens.usdt.toLowerCase()
        ? { fee: { amount: String(log.fee.amount), symbol: "USDT" } } : {}),
      party, vault: sent ? destinationVault : log.address, address: sent ? log.recipient : log.address,
    });
  }
  return [...payments.values()].sort((a, b) => newestReceiptFirst(a.log, b.log));
}

const PAGE_SIZE = 10;
export async function historyPage(payments: Payment[], filter: HistoryFilter, contact: string | null,
  before: string | null, reader: HistoryReader): Promise<HistoryPage> {
  const address = contact?.toLowerCase();
  const matches = payments.filter(({ party }) => !address || address === party.wallet.toLowerCase()
    || party.vaults.some(vault => vault.toLowerCase() === address));
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
    payments: page.map(({ log, party, ...p }) => ({ ...p, wallet: party.wallet, hash: log.hash, logIndex: log.logIndex,
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
  factory: Address | readonly Address[]; reader: HistoryReader | null; resolveOwner: (request: Request) => Promise<OwnerResult>;
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
