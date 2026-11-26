import type { DepegDecision } from "../depeg/guard";
import { formatUnits, getAddress, isAddress, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import type { VaultRevert } from "../chain/errors";
import type { VaultSnapshot } from "../chain/gateway";
import { oneLine } from "../validation";
import type { RecipientEntry, TokenSymbol } from "./directory";
import type { PlanDraft } from "./schema";

export interface PlannedPayment {
  recipientName: string;
  recipient: Address | null;
  /** 18-decimal token units; null when the amount couldn't be used. */
  amount: bigint | null;
  token: TokenSymbol;
  warnings: string[];
  /** The vault's verdict from a simulation, when one was run (null = it would go through). */
  preview?: VaultRevert | null;
}

export interface Plan {
  id: string;
  /** bytes32 sent with every pay() of this plan; each (ref, recipient) pays once. */
  ref: Hex;
  owner: Address;
  vault: Address | null;
  message: string;
  kind: PlanDraft["kind"];
  /** "now", a UTC calendar day (YYYY-MM-DD), or Claude's text when it wasn't a readable date. */
  scheduledFor: string;
  payments: PlannedPayment[];
  notes: string[];
  createdAt: string;
  /**
   * The depeg guard's decision (Cournot's USDC depeg risk against the owner's limit), when it ran,
   * with its sentence. The sentence is also in `notes` (so the owner signs it); the card reads it from here.
   */
  depeg?: DepegDecision & { note: string };
}

export type ExecutablePayment = PlannedPayment & { recipient: Address; amount: bigint };

export function isExecutable(payment: PlannedPayment): payment is ExecutablePayment {
  return payment.recipient !== null && payment.amount !== null;
}

/** The plan's on-chain reference: a hash of its id. */
export function planRef(id: string): Hex {
  return keccak256(toHex(id));
}

/** A real UTC calendar day written as YYYY-MM-DD (so not 2026-02-30). */
export const isCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/**
 * True when the plan may run on `now`'s day: it says "now", or its date has
 * arrived. Days are UTC, like the vault's daily limit (07:00 in Bangkok).
 * A date that couldn't be read is never due on its own.
 */
export function isDue(plan: Plan, now: Date): boolean {
  if (plan.scheduledFor === "now") return true;
  return isCalendarDate(plan.scheduledFor) && plan.scheduledFor <= now.toISOString().slice(0, 10);
}

// Stablecoin amounts are treated 1:1 with USD, as in the vault's caps.
const USD_FAMILY = new Set(["USD", "USDT", "USDC", "$", "US$"]);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Who is a payment for? When Claude copied an address, the address alone decides:
 * a matching name never vouches for an address the directory doesn't know. Without
 * an address, the name has to match exactly one directory entry.
 */
function resolveRecipient(
  directory: RecipientEntry[],
  name: string,
  address: Address | null,
): { entry?: RecipientEntry; warning?: string } {
  const wanted = name.trim().toLowerCase();
  const byName = directory.filter((e) => e.name.toLowerCase() === wanted);
  if (address) {
    const byAddress = directory.find((e) => e.address === address);
    if (byAddress) {
      if (byName.length > 0 && !byName.includes(byAddress)) {
        return { entry: byAddress, warning: `The message says ${name}, but ${short(address)} is ${byAddress.name}'s address in your directory.` };
      }
      return { entry: byAddress };
    }
    const [named] = byName;
    return {
      warning: named
        ? `${short(address)} is not ${named.name}'s address in your directory (${short(named.address)}). Check who this really is before paying.`
        : `${short(address)} is not in your recipient directory.`,
    };
  }
  if (byName.length > 1) return { warning: `More than one recipient is named ${name}. Use an address to pick one.` };
  const [entry] = byName;
  return entry ? { entry } : { warning: `${name} is not in your recipient directory.` };
}

// Digits, optional thousands commas ("1,000.50") and a dot for decimals. Any other
// comma ("1,5" or "0,500" mean 1.5 and 0.5 in much of Asia and Europe) is ambiguous,
// so it is refused. A thousands group never starts with 0.
const AMOUNT = /^([1-9]\d{0,2}(,\d{3})+|\d+)(\.\d+)?$/;
/** Larger than any single payroll payment: almost certainly a typo or an injected number. */
const MAX_AMOUNT = parseUnits("1000000000", 18);

function readAmount(raw: string): { amount: bigint } | { warning: string } {
  const shown = oneLine(raw, 40);
  const cleaned = raw.replace(/[\s$]/g, "");
  if (!AMOUNT.test(cleaned)) {
    return {
      warning: cleaned.includes(",")
        ? `"${shown}" is ambiguous: write decimals with a dot, like 1.5.`
        : `"${shown}" is not a number.`,
    };
  }
  if ((cleaned.split(".")[1] ?? "").length > 18) return { warning: `"${shown}" has more than 18 decimals.` };
  const amount = parseUnits(cleaned.replaceAll(",", ""), 18);
  if (amount === 0n) return { warning: "The amount must be more than zero." };
  if (amount > MAX_AMOUNT) return { warning: `"${shown}" is more than one billion. Check the amount.` };
  return { amount };
}

export interface BuildContext {
  id: string;
  owner: Address;
  vault: Address | null;
  message: string;
  directory: RecipientEntry[];
  now: Date;
  /**
   * The depeg guard's coin, when it gave one. It decides every payment whose coin the owner
   * didn't name; a named coin is kept, except that USDC is never paid when the guard says USDT.
   */
  coin?: TokenSymbol;
}

export const SWITCHED_TO_USDT = "You named USDC, but Cournot puts its depeg risk above your limit, so this is paid in USDT.";

/**
 * Turns Claude's draft into a plan the executor can run. This is plain code, not
 * the model: it validates addresses, parses amounts without floats, flags unknown
 * recipients, and merges repeat payments to one person (the vault pays each
 * recipient once per plan). It never decides who may be paid; the vault does.
 */
export function buildPlan(draft: PlanDraft, ctx: BuildContext): Plan {
  // Claude's notes are model text: one that looks like the depeg guard's sentence is marked as Claude's.
  const notes = draft.notes.map((note) => {
    const line = oneLine(note, 300);
    return /^\s*depeg guard/i.test(line) ? `From Claude: ${line}` : line;
  });
  const payments: PlannedPayment[] = [];
  const byRecipient = new Map<Address, PlannedPayment>();

  if (draft.kind !== "payment" && draft.payments.length > 0) {
    notes.push("This message isn't a payment request, so the payments in Claude's reply were dropped.");
  }
  const items = draft.kind === "payment" ? draft.payments : [];

  for (const item of items) {
    const warnings: string[] = [];
    const name = oneLine(item.recipient_name) || "Unnamed recipient";

    let recipient: Address | null = null;
    const rawAddress = item.recipient_address.trim();
    if (rawAddress) {
      if (isAddress(rawAddress, { strict: false })) recipient = getAddress(rawAddress);
      else warnings.push(`"${oneLine(rawAddress, 50)}" is not a valid address.`);
    }
    const { entry, warning } = resolveRecipient(ctx.directory, name, recipient);
    if (warning) warnings.push(warning);
    if (!recipient && entry && !warning) recipient = entry.address;

    const currency = oneLine(item.currency, 10).toUpperCase() || "USD";
    let amount: bigint | null = null;
    if (!USD_FAMILY.has(currency)) {
      warnings.push(`Amounts in ${currency} need a currency conversion, which isn't connected yet.`);
    } else {
      const read = readAmount(item.amount);
      if ("amount" in read) amount = read.amount;
      else warnings.push(read.warning);
    }

    const named: TokenSymbol | null = currency === "USDC" || currency === "USDT" ? currency : null;
    // Decided here, before merging, so merging and the "already gets" check see the final coin.
    const switched = named === "USDC" && ctx.coin === "USDT";
    const token: TokenSymbol = switched ? "USDT" : (named ?? ctx.coin ?? entry?.preferredToken ?? "USDT");
    const recipientName = entry?.name ?? name;

    const earlier = recipient ? byRecipient.get(recipient) : undefined;
    if (earlier && amount !== null) {
      // Merge only a plain repeat ("Marco 100 ... Marco 50"). A line that names someone
      // else, or that was flagged, is held back: merging would hide it inside a payment
      // that looks fine.
      const sameName = earlier.recipientName.toLowerCase() === recipientName.toLowerCase();
      if (sameName && warnings.length === 0 && earlier.token === token && earlier.amount !== null) {
        earlier.amount += amount;
        if (switched && !earlier.warnings.includes(SWITCHED_TO_USDT)) earlier.warnings.push(SWITCHED_TO_USDT);
        notes.push(`Combined two payments to ${earlier.recipientName} into one: a plan pays each person once.`);
        continue;
      }
      warnings.push(
        sameName && earlier.token !== token
          ? `${recipientName} already gets ${earlier.token} in this plan; one plan can't pay a person twice.`
          : `${short(recipient as Address)} already gets a payment in this plan (as ${earlier.recipientName}); one plan pays each address once, so this line is held back.`,
      );
      amount = null;
    }

    if (switched) warnings.push(SWITCHED_TO_USDT);
    const planned: PlannedPayment = { recipientName, recipient, amount, token, warnings };
    if (recipient && amount !== null) byRecipient.set(recipient, planned);
    payments.push(planned);
  }

  const date = draft.scheduled_for.trim();
  const scheduledFor = date === "" || date.toLowerCase() === "now" ? "now" : isCalendarDate(date) ? date : oneLine(date, 40);
  if (scheduledFor !== "now" && !isCalendarDate(scheduledFor)) {
    notes.push(`Couldn't read the date "${scheduledFor}". The plan runs only if you approve paying early.`);
  } else if (scheduledFor !== "now" && scheduledFor < ctx.now.toISOString().slice(0, 10)) {
    notes.push(`The date ${scheduledFor} has already passed, so this plan can run right away. If you meant a later date, say so.`);
  }

  return {
    id: ctx.id,
    ref: planRef(ctx.id),
    owner: ctx.owner,
    vault: ctx.vault,
    message: ctx.message,
    kind: draft.kind,
    scheduledFor,
    payments,
    notes,
    createdAt: ctx.now.toISOString(),
  };
}

/**
 * The vault checks each previewed payment on its own. These notes say when the
 * payments it would accept can't all go through together, because the balance or
 * today's limit runs out partway.
 */
export function planLimitNotes(plan: Plan, snapshot: VaultSnapshot): string[] {
  const going = plan.payments.filter((p): p is ExecutablePayment => isExecutable(p) && !p.preview);
  const fmt = (value: bigint) => formatUnits(value, 18);
  const notes: string[] = [];
  for (const token of ["USDT", "USDC"] as const) {
    const need = going.filter((p) => p.token === token).reduce((sum, p) => sum + p.amount, 0n);
    const have = snapshot.balances[token];
    if (need > have) {
      notes.push(`Together these payments need ${fmt(need)} ${token}, but the vault holds ${fmt(have)} ${token}. The last ones will be refused.`);
    }
  }
  const total = going.reduce((sum, p) => sum + p.amount, 0n);
  const left = snapshot.rules.dailyCap > snapshot.spentToday ? snapshot.rules.dailyCap - snapshot.spentToday : 0n;
  if (total > left) {
    notes.push(`Together these payments total $${fmt(total)}, more than the $${fmt(left)} left in today's limit. The last ones will be refused.`);
  }
  return notes;
}
