import { formatUnits, type Address } from "viem";
import { ALREADY_PAID_NOTE, type AttackResult, type PaymentResult } from "../execution/executor";
import type { Plan } from "../plan/build";
import type { RecipientEntry } from "../plan/directory";
import { oneLine } from "../validation";
import { BrainError, type BrainClient, type BrainNote } from "./brain";

/**
 * The agent's memory on top of Living Brain. Before a plan it recalls what it saved about this
 * owner's recipients; after the fact it saves payouts, vault refusals, attack attempts and
 * recipients. Memory never decides anything and never blocks a payment: a failure is shown, not thrown.
 */

const TOP_K = 8;
/** Pages read per plan: each is one more call before Claude can start. */
const MAX_PAGES = 4;
/** Characters kept per recalled page, for Claude and for the card. */
const MAX_NOTE_CHARS = 600;
/** After a failed search, plans skip memory at once for this long. */
const FAILURE_MS = 30 * 1000;
/** After a failed save, later saves are skipped for this long instead of piling up behind the outage. */
const SAVE_BACKOFF_MS = 60 * 1000;
/** Most saves waiting at once; past it, a new note is dropped (and logged) rather than queued. */
const MAX_PENDING = 50;

/**
 * Every note starts with its owner's tag. One Living Brain subject holds every owner's notes (the
 * API key can act for one subject only), so recall keeps a page only when it carries this owner's
 * tag and no other owner's. A recipient's address is never written in tag form, and text the owner
 * typed is cleaned of the tag, so one owner's notes can't be recalled by another.
 */
const TAG = "leashpay-owner:";
export const ownerTag = (owner: Address) => `[${TAG}${owner.toLowerCase()}]`;
const clean = (text: string, max: number) => oneLine(text, max).replaceAll(new RegExp(TAG, "gi"), "");

/** True when the page holds this owner's notes and nobody else's. */
export function isOwnersPage(text: string, owner: Address): boolean {
  const tags = new Set([...text.toLowerCase().matchAll(/leashpay-owner:(0x[0-9a-f]{40})/g)].map((m) => m[1]));
  return tags.size === 1 && tags.has(owner.toLowerCase());
}

export interface MemoryNote {
  title: string;
  text: string;
}

export type Recall =
  | { available: true; notes: MemoryNote[]; writeError?: string }
  | { available: false; reason: string; writeError?: string };

export interface Memory {
  recall(owner: Address, query: string): Promise<Recall>;
  /** Saves in the background, one note at a time; the outcome shows on the next plan. */
  remember(note: BrainNote): Promise<void>;
}

export function createMemory(options: { client: BrainClient; now?: () => number; log?: (line: string) => void }): Memory {
  const { client } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  let failed: { until: number; reason: string } | null = null;
  let writeError: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let backoffUntil = 0;
  const reasonOf = (err: unknown, fallback: string) => (err instanceof BrainError ? err.message : fallback);

  return {
    async recall(owner, query) {
      const withWrite = <T extends object>(r: T) => (writeError ? { ...r, writeError } : r);
      if (failed && failed.until > now()) return withWrite({ available: false as const, reason: failed.reason });
      try {
        const hits = await client.search(query.slice(0, 500), TOP_K);
        const slugs = [...new Set(hits.map((h) => h.slug))].slice(0, MAX_PAGES);
        const pages = await Promise.all(slugs.map((s) => client.page(s).catch(() => null)));
        if (slugs.length > 0 && pages.every((p) => p === null)) throw new BrainError("Living Brain found pages but none of them could be read.");
        const notes = pages
          .filter((p): p is NonNullable<typeof p> => p !== null && isOwnersPage(p.text, owner))
          .map((p) => ({ title: oneLine(p.title, 120), text: p.text.slice(0, MAX_NOTE_CHARS) }));
        return withWrite({ available: true as const, notes });
      } catch (err) {
        const reason = reasonOf(err, "Living Brain couldn't be reached.");
        failed = { until: now() + FAILURE_MS, reason };
        return withWrite({ available: false as const, reason });
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
            log(`memory: not saved (${note.originRef}): ${writeError ?? "saves paused"} (retrying saves after a pause)`);
            return;
          }
          await client.capture(note);
          writeError = undefined;
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

const day = (iso: string) => iso.slice(0, 10);
const amountOf = (amount: string | null, token: string) => (amount === null ? "an unreadable amount" : `${formatUnits(BigInt(amount), 18)} ${token}`);

/** What a run of the plan teaches the agent: each payout and each vault refusal. */
export function notesForRun(plan: Plan, results: PaymentResult[], at: Date): BrainNote[] {
  return results.flatMap((r): BrainNote[] => {
    const who = `${clean(r.recipientName, 60)} (${r.recipient ?? "no address"})`;
    // A row an earlier run paid was saved then; saving it again would date it today.
    if (r.status === "paid" && r.hash && r.note !== ALREADY_PAID_NOTE) {
      return [
        {
          label: `Payout to ${clean(r.recipientName, 60)}`,
          content: `${ownerTag(plan.owner)} LeashPay payout on ${day(at.toISOString())} UTC. Owner ${plan.owner} paid ${who} ${amountOf(r.amount, r.token)} through vault ${plan.vault}. Transaction ${r.hash}. Plan ref ${plan.ref}.`,
          originRef: `leashpay:paid:${r.hash}`,
        },
      ];
    }
    if (r.status === "refused" && r.error) {
      const why = typeof r.error === "string" ? clean(r.error, 200) : `${r.error.name}: ${clean(r.error.message, 200)}`;
      return [
        {
          label: `Vault refused a payment to ${clean(r.recipientName, 60)}`,
          content: `${ownerTag(plan.owner)} LeashPay refusal on ${day(at.toISOString())} UTC. The vault of owner ${plan.owner} refused ${amountOf(r.amount, r.token)} to ${who}. Reason: ${why}.`,
          originRef: `leashpay:refused:${plan.id}:${r.index}`,
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
      content: `${ownerTag(plan.owner)} LeashPay attack attempt on ${day(at.toISOString())} UTC. A payment to ${r.recipient} was sent from owner ${plan.owner}'s vault ${plan.vault} without the owner's signature, playing a hacked agent. The vault refused it on-chain${r.reason ? ` with ${r.reason}` : ""}. Transaction ${r.hash}. Treat payments to ${r.recipient} as suspicious.`,
      originRef: `leashpay:attack:${r.hash}`,
    }));
}

/** A recipient the owner saved, with the preferences that stay off-chain. */
export function noteForRecipient(owner: Address, entry: RecipientEntry): BrainNote {
  const details = [
    entry.country && `country ${clean(entry.country, 60)}`,
    entry.currency && `local currency ${entry.currency}`,
    entry.preferredToken && `prefers to be paid in ${entry.preferredToken}`,
  ].filter(Boolean);
  return {
    label: `Recipient ${clean(entry.name, 60)}`,
    content: `${ownerTag(owner)} LeashPay recipient. Owner ${owner} saved ${clean(entry.name, 60)} (${entry.address})${details.length ? `: ${details.join(", ")}` : ""}.`,
    originRef: `leashpay:recipient:${owner.toLowerCase()}:${entry.address.toLowerCase()}`,
  };
}
