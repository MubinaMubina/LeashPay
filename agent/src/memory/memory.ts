import { formatUnits, type Address } from "viem";
import { ALREADY_PAID_NOTE, CONFIRMED_EARLIER_NOTE, type AttackResult, type PaymentResult } from "../execution/executor";
import type { Plan } from "../plan/build";
import type { RecipientEntry } from "../plan/directory";
import { oneLine } from "../validation";
import { BrainError, type BrainClient, type BrainNote, type BrainSource } from "./brain";

/**
 * The agent's memory on top of Living Brain. Before a plan it recalls what it saved about this
 * owner; after the fact it saves payouts, vault refusals, attack attempts and recipients. Memory
 * never decides anything and never blocks a payment: a failure is shown, not thrown.
 *
 * Owners are kept apart by the agent, from data it wrote itself. The API key can act for one
 * Living Brain subject only, so every owner's notes share it, and the pages Living Brain compiles
 * from them can mix owners. Recall therefore never reads compiled pages: it returns the agent's
 * own captures (sources), word for word, whose originRef starts with `leashpay:<owner>:`. Search
 * only ranks them.
 */

const TOP_K = 20;
/** Notes given to Claude per plan. */
const MAX_NOTES = 6;
/** Characters kept per note, for Claude and for the card. */
const MAX_NOTE_CHARS = 600;
/** Captures read per recall (two pages of 100). */
const SOURCE_PAGES = 2;
/** The capture list serves plans for this long; a new save clears it. */
const SOURCES_CACHE_MS = 60 * 1000;
/** After a failed recall, plans skip memory at once for this long. */
const FAILURE_MS = 30 * 1000;
/** After a failed save, later saves are skipped for this long instead of piling up behind the outage. */
const SAVE_BACKOFF_MS = 60 * 1000;
/** Most saves waiting at once; past it, a new note is dropped (and logged) rather than queued. */
const MAX_PENDING = 50;

/** Every originRef the agent writes starts with this, so a capture's owner is known from the agent's own data. */
export const ownerPrefix = (owner: Address) => `leashpay:${owner.toLowerCase()}:`;

export interface MemoryNote {
  title: string;
  text: string;
}

export type Recall =
  | { available: true; notes: MemoryNote[]; links?: string[]; writeError?: string }
  | { available: false; reason: string; writeError?: string };

export interface Memory {
  recall(owner: Address, query: string): Promise<Recall>;
  /**
   * What memory knows about the people this plan pays: an earlier attack on the address, the
   * last payout to it. Reads the notes recall already loaded; an outage gives no links, never an error.
   */
  connect(owner: Address, payees: readonly Payee[]): Promise<string[]>;
  /** Saves in the background, one note at a time; the outcome shows on the next plan. */
  remember(note: BrainNote): Promise<void>;
}

/** This owner's captures, ranked: those behind the search hits first (in hit order), then the newest. */
export function rankOwnNotes(owner: Address, sources: BrainSource[], hitPageIds: string[]): MemoryNote[] {
  const prefix = ownerPrefix(owner);
  const mine = sources.filter((s) => s.originRef.toLowerCase().startsWith(prefix) && s.status !== "failed");
  const rank = (s: BrainSource) => {
    const i = hitPageIds.findIndex((id) => s.affectedPageIds.includes(id));
    return i === -1 ? hitPageIds.length : i;
  };
  return mine
    .map((s, order) => ({ s, order }))
    .sort((a, b) => rank(a.s) - rank(b.s) || (b.s.createdAt ?? 0) - (a.s.createdAt ?? 0) || a.order - b.order)
    .slice(0, MAX_NOTES)
    .map(({ s }) => ({ title: oneLine(s.label ?? s.originRef, 120), text: s.content.slice(0, MAX_NOTE_CHARS) }));
}

export interface Payee {
  name: string;
  address: Address;
}

const ADDRESS = /0x[0-9a-fA-F]{40}/;
const kindOf = (s: BrainSource, prefix: string) => s.originRef.slice(prefix.length).split(":")[0];
/** The date the agent wrote into the note ("… on 2026-11-26 UTC"), else when Living Brain stored it. */
const dateOf = (s: BrainSource) =>
  /\b(\d{4}-\d{2}-\d{2})\b/.exec(s.content)?.[1] ?? (s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : "an earlier date");
const newestFirst = (a: BrainSource, b: BrainSource) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

/**
 * Connects this plan's payees to what the agent saved earlier, from its own notes only (the
 * `leashpay:<owner>:` prefix). Attack attempts come first: they are the link the owner must not miss.
 * Payouts are matched on "(address)", the form notesForRun writes, so an owner's or vault's own
 * address in the same sentence never counts as the payee.
 */
export function linkPayees(owner: Address, sources: readonly BrainSource[], payees: readonly Payee[]): string[] {
  const prefix = ownerPrefix(owner);
  const mine = sources.filter((s) => s.originRef.toLowerCase().startsWith(prefix) && s.status !== "failed");
  const seen = new Set<string>();
  const attacks: string[] = [];
  const payouts: string[] = [];
  for (const payee of payees) {
    const address = payee.address.toLowerCase();
    if (seen.has(address) || address === owner.toLowerCase()) continue;
    seen.add(address);
    const about = (kind: string, needle: string) =>
      mine.filter((s) => kindOf(s, prefix) === kind && s.content.toLowerCase().includes(needle)).sort(newestFirst);
    const attack = about("attack", `to ${address}`)[0];
    if (attack) {
      attacks.push(`Living Brain: ${payee.address} was the target of an attack attempt on ${dateOf(attack)}, and the vault refused it. Treat this payment as suspicious.`);
    }
    const paid = about("paid", `(${address})`);
    if (paid.length > 0) {
      const last = paid[0]!;
      const amount = new RegExp(`\\(${ADDRESS.source}\\) ([0-9.]+ (?:USDT|USDC))`).exec(last.content)?.[1];
      const times = paid.length > 1 ? ` (${paid.length} payouts remembered)` : "";
      payouts.push(`Living Brain: you last paid ${oneLine(payee.name, 60)}${amount ? ` ${amount}` : ""} on ${dateOf(last)}${times}.`);
    }
  }
  return [...attacks, ...payouts];
}

export function createMemory(options: { client: BrainClient; now?: () => number; log?: (line: string) => void }): Memory {
  const { client } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  let failed: { until: number; reason: string } | null = null;
  let writeError: string | undefined;
  let sourcesCache: { until: number; sources: Promise<BrainSource[]> } | null = null;
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let backoffUntil = 0;
  const reasonOf = (err: unknown, fallback: string) => (err instanceof BrainError ? err.message : fallback);

  function allSources(): Promise<BrainSource[]> {
    if (sourcesCache && sourcesCache.until > now()) return sourcesCache.sources;
    const sources = (async () => {
      const pages = await Promise.all(Array.from({ length: SOURCE_PAGES }, (_, i) => client.sources(100, i * 100)));
      return pages.flat();
    })();
    sourcesCache = { until: now() + SOURCES_CACHE_MS, sources };
    sources.catch(() => (sourcesCache = null));
    return sources;
  }

  return {
    async recall(owner, query) {
      const withWrite = <T extends object>(r: T) => (writeError ? { ...r, writeError } : r);
      if (failed && failed.until > now()) return withWrite({ available: false as const, reason: failed.reason });
      try {
        const [hits, sources] = await Promise.all([client.search(query.slice(0, 500), TOP_K), allSources()]);
        return withWrite({ available: true as const, notes: rankOwnNotes(owner, sources, hits.map((h) => h.pageId)) });
      } catch (err) {
        const reason = reasonOf(err, "Living Brain couldn't be reached.");
        failed = { until: now() + FAILURE_MS, reason };
        return withWrite({ available: false as const, reason });
      }
    },
    async connect(owner, payees) {
      if (payees.length === 0 || (failed && failed.until > now())) return [];
      try {
        return linkPayees(owner, await allSources(), payees);
      } catch {
        return []; // recall already reports the outage on the plan
      }
    },
    remember(note) {
      if (pending >= MAX_PENDING) {
        log(`memory: not saved (${note.originRef}): ${MAX_PENDING} saves already waiting`);
        return queue;
      }
      pending++;
      queue = queue.then(async () => {
        try {
          if (backoffUntil > now()) {
            log(`memory: not saved (${note.originRef}): ${writeError ?? "saves paused"} (saves paused after a failure)`);
            return;
          }
          await client.capture(note);
          writeError = undefined;
          sourcesCache = null; // the next recall sees it
        } catch (err) {
          writeError = reasonOf(err, "Living Brain couldn't be reached.");
          backoffUntil = now() + SAVE_BACKOFF_MS;
          log(`memory: not saved (${note.originRef}): ${writeError}`);
        } finally {
          pending--;
        }
      });
      return queue;
    },
  };
}

const day = (at: Date) => at.toISOString().slice(0, 10);
const amountOf = (amount: string | null, token: string) => (amount === null ? "an unreadable amount" : `${formatUnits(BigInt(amount), 18)} ${token}`);

/** What a run of the plan teaches the agent: each payout and each vault refusal. */
export function notesForRun(plan: Plan, results: PaymentResult[], at: Date): BrainNote[] {
  const prefix = ownerPrefix(plan.owner);
  return results.flatMap((r): BrainNote[] => {
    const who = `${oneLine(r.recipientName, 60)} (${r.recipient ?? "no address"})`;
    if (r.status === "paid" && r.note !== ALREADY_PAID_NOTE) {
      // Sent in this run, or sent earlier and only confirmed now: the date says which.
      const when = r.note === CONFIRMED_EARLIER_NOTE ? `sent in an earlier run, confirmed on ${day(at)} UTC` : `on ${day(at)} UTC`;
      return [
        {
          label: `Payout to ${oneLine(r.recipientName, 60)}`,
          content: `LeashPay payout ${when}. Owner ${plan.owner} paid ${who} ${amountOf(r.amount, r.token)} through vault ${plan.vault}. ${r.hash ? `Transaction ${r.hash}` : "Transaction hash unknown (the vault confirmed the payment as already made)"}. Plan ref ${plan.ref}.`,
          // Without a hash, the plan and row identify the payment.
          originRef: `${prefix}paid:${r.hash ?? `${plan.id}:${r.index}`}`,
        },
      ];
    }
    if (r.status === "refused" && r.error) {
      const why = typeof r.error === "string" ? oneLine(r.error, 200) : `${r.error.name}: ${oneLine(r.error.message, 200)}`;
      return [
        {
          label: `Vault refused a payment to ${oneLine(r.recipientName, 60)}`,
          content: `LeashPay refusal on ${day(at)} UTC. The vault of owner ${plan.owner} refused ${amountOf(r.amount, r.token)} to ${who}. Reason: ${why}.`,
          originRef: `${prefix}refused:${plan.id}:${r.index}`,
        },
      ];
    }
    return [];
  });
}

/** The demo attack the vault refused: remembered so the next plan to that address is flagged. */
export function notesForAttack(plan: Plan, results: AttackResult[], at: Date): BrainNote[] {
  return results
    .filter((r) => r.status === "reverted")
    .map((r) => ({
      label: `Attack attempt to ${r.recipient}`,
      content: `LeashPay attack attempt on ${day(at)} UTC. A payment to ${r.recipient} was sent from owner ${plan.owner}'s vault ${plan.vault} without the owner's signature, playing a hacked agent. The vault refused it on-chain${r.reason ? ` with ${r.reason}` : ""}. Transaction ${r.hash}. Treat payments to ${r.recipient} as suspicious.`,
      originRef: `${ownerPrefix(plan.owner)}attack:${r.hash}`,
    }));
}

/** A recipient the owner saved, with the preferences that stay off-chain. */
export function noteForRecipient(owner: Address, entry: RecipientEntry): BrainNote {
  const details = [
    entry.country && `country ${oneLine(entry.country, 60)}`,
    entry.currency && `local currency ${entry.currency}`,
    entry.preferredToken && `prefers to be paid in ${entry.preferredToken}`,
  ].filter(Boolean);
  return {
    label: `Recipient ${oneLine(entry.name, 60)}`,
    content: `LeashPay recipient. Owner ${owner} saved ${oneLine(entry.name, 60)} (${entry.address})${details.length ? `: ${details.join(", ")}` : ""}.`,
    originRef: `${ownerPrefix(owner)}recipient:${entry.address.toLowerCase()}`,
  };
}
