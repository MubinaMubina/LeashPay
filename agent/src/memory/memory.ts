import { formatUnits, type Address } from "viem";
import type { AttackResult, PaymentResult } from "../execution/executor";
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
  const reasonOf = (err: unknown, fallback: string) => (err instanceof BrainError ? err.message : fallback);

  return {
    async recall(owner, query) {
      const withWrite = <T extends object>(r: T) => (writeError ? { ...r, writeError } : r);
      if (failed && failed.until > now()) return withWrite({ available: false as const, reason: failed.reason });
      try {
        const hits = await client.search(query.slice(0, 500), TOP_K);
        const slugs = [...new Set(hits.map((h) => h.slug))].slice(0, MAX_PAGES);
        const pages = await Promise.all(slugs.map((s) => client.page(s).catch(() => null)));
        const mine = owner.toLowerCase();
        // One subject holds every owner's notes, and every note names its owner: keep this owner's only.
        const notes = pages
          .filter((p): p is NonNullable<typeof p> => p !== null && p.text.toLowerCase().includes(mine))
          .map((p) => ({ title: oneLine(p.title, 120), text: p.text.slice(0, MAX_NOTE_CHARS) }));
        return withWrite({ available: true as const, notes });
      } catch (err) {
        const reason = reasonOf(err, "Living Brain couldn't be reached.");
        failed = { until: now() + FAILURE_MS, reason };
        return withWrite({ available: false as const, reason });
      }
    },
    remember(note) {
      queue = queue.then(async () => {
        try {
          await client.capture(note);
          writeError = undefined;
        } catch (err) {
          writeError = reasonOf(err, "Living Brain couldn't be reached.");
          log(`memory: not saved (${note.originRef}): ${writeError}`);
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
    const who = `${oneLine(r.recipientName, 60)} (${r.recipient ?? "no address"})`;
    if (r.status === "paid" && r.hash) {
      return [
        {
          label: `Payout to ${oneLine(r.recipientName, 60)}`,
          content: `LeashPay payout on ${day(at.toISOString())} UTC. Owner ${plan.owner} paid ${who} ${amountOf(r.amount, r.token)} through vault ${plan.vault}. Transaction ${r.hash}. Plan ref ${plan.ref}.`,
          originRef: `leashpay:paid:${r.hash}`,
        },
      ];
    }
    if (r.status === "refused" && r.error) {
      const why = typeof r.error === "string" ? oneLine(r.error, 200) : `${r.error.name}: ${oneLine(r.error.message, 200)}`;
      return [
        {
          label: `Vault refused a payment to ${oneLine(r.recipientName, 60)}`,
          content: `LeashPay refusal on ${day(at.toISOString())} UTC. The vault of owner ${plan.owner} refused ${amountOf(r.amount, r.token)} to ${who}. Reason: ${why}.`,
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
      content: `LeashPay attack attempt on ${day(at.toISOString())} UTC. A payment to ${r.recipient} was sent from owner ${plan.owner}'s vault ${plan.vault} without the owner's signature, playing a hacked agent. The vault refused it on-chain${r.reason ? ` with ${r.reason}` : ""}. Transaction ${r.hash}. Treat payments to ${r.recipient} as suspicious.`,
      originRef: `leashpay:attack:${r.hash}`,
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
    originRef: `leashpay:recipient:${owner.toLowerCase()}:${entry.address.toLowerCase()}`,
  };
}
