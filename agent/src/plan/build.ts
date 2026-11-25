import { getAddress, isAddress, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import type { VaultRevert } from "../chain/errors";
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
  scheduledFor: string;
  payments: PlannedPayment[];
  notes: string[];
  createdAt: string;
}

export type ExecutablePayment = PlannedPayment & { recipient: Address; amount: bigint };

export function isExecutable(payment: PlannedPayment): payment is ExecutablePayment {
  return payment.recipient !== null && payment.amount !== null;
}

/** The plan's on-chain reference: a hash of its id. */
export function planRef(id: string): Hex {
  return keccak256(toHex(id));
}

// Stablecoin amounts are treated 1:1 with USD, as in the vault's caps.
const USD_FAMILY = new Set(["USD", "USDT", "USDC", "$", "US$"]);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function findEntry(directory: RecipientEntry[], name: string, address: Address | null) {
  if (address) {
    const byAddress = directory.find((e) => e.address === address);
    if (byAddress) return byAddress;
  }
  const wanted = name.trim().toLowerCase();
  return directory.find((e) => e.name.toLowerCase() === wanted);
}

function parseAmount(raw: string): bigint | null {
  const cleaned = raw.replace(/[,\s$]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseUnits(cleaned, 18);
}

export interface BuildContext {
  id: string;
  owner: Address;
  vault: Address | null;
  message: string;
  directory: RecipientEntry[];
  now: Date;
}

/**
 * Turns Claude's draft into a plan the executor can run. This is plain code, not
 * the model: it validates addresses, parses amounts without floats, flags unknown
 * recipients, and merges repeat payments to one person (the vault pays each
 * recipient once per plan). It never decides who may be paid; the vault does.
 */
export function buildPlan(draft: PlanDraft, ctx: BuildContext): Plan {
  const notes = [...draft.notes];
  const payments: PlannedPayment[] = [];
  const byRecipient = new Map<Address, PlannedPayment>();

  for (const item of draft.payments) {
    const warnings: string[] = [];

    let recipient: Address | null = null;
    const rawAddress = item.recipient_address.trim();
    if (rawAddress) {
      if (isAddress(rawAddress, { strict: false })) recipient = getAddress(rawAddress);
      else warnings.push(`"${rawAddress}" is not a valid address.`);
    }
    const entry = findEntry(ctx.directory, item.recipient_name, recipient);
    if (!recipient && entry) recipient = entry.address;
    if (!recipient) warnings.push(`${item.recipient_name} is not in your recipient directory.`);
    else if (!entry) warnings.push(`${short(recipient)} is not in your recipient directory.`);

    const currency = item.currency.trim().toUpperCase() || "USD";
    let amount: bigint | null = null;
    if (!USD_FAMILY.has(currency)) {
      warnings.push(`Amounts in ${currency} need a currency conversion, which isn't connected yet.`);
    } else {
      amount = parseAmount(item.amount);
      if (amount === null) warnings.push(`"${item.amount}" is not a number.`);
      else if (amount === 0n) {
        warnings.push("The amount must be more than zero.");
        amount = null;
      }
    }

    const token: TokenSymbol =
      currency === "USDC" ? "USDC" : currency === "USDT" ? "USDT" : (entry?.preferredToken ?? "USDT");
    const recipientName = entry?.name ?? item.recipient_name;

    const earlier = recipient ? byRecipient.get(recipient) : undefined;
    if (earlier && amount !== null) {
      if (earlier.token === token && earlier.amount !== null) {
        earlier.amount += amount;
        notes.push(`Combined two payments to ${recipientName} into one: a plan pays each person once.`);
        continue;
      }
      warnings.push(`${recipientName} already gets ${earlier.token} in this plan; one plan can't pay a person twice.`);
      amount = null;
    }

    const planned: PlannedPayment = { recipientName, recipient, amount, token, warnings };
    if (recipient && amount !== null) byRecipient.set(recipient, planned);
    payments.push(planned);
  }

  return {
    id: ctx.id,
    ref: planRef(ctx.id),
    owner: ctx.owner,
    vault: ctx.vault,
    message: ctx.message,
    kind: draft.kind,
    scheduledFor: draft.scheduled_for,
    payments,
    notes,
    createdAt: ctx.now.toISOString(),
  };
}
