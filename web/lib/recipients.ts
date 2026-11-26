import { getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { DEMO_ATTACK_ADDRESS } from "./demo";
import { FX_CURRENCIES } from "./fx";

/**
 * Local currencies the owner can pick: the ones the app shows rates for, plus USD for
 * no conversion (the coins already track the dollar).
 */
export const CURRENCIES = [...FX_CURRENCIES, "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Same limits as the agent's directory (agent/src/plan/directory.ts). */
const NAME_MAX = 60;
const COUNTRY_MAX = 60;
/** A cap above this is almost certainly a typo, and BSC tokens use 18 decimals. */
const CAP_MAX = parseUnits("1000000000", 18);

export interface RecipientForm {
  name: string;
  address: string;
  country: string;
  currency: string;
  /** Monthly cap in whole tokens as typed, for example "1000" or "250.5". */
  monthlyCap: string;
}

export interface NewRecipient {
  name: string;
  address: Address;
  country?: string;
  currency: Currency;
  monthlyCap: bigint;
}

/** A recipient as the dashboard shows it: the agent's directory entry plus the vault's view of it. */
export interface ListedRecipient {
  name: string;
  address: Address;
  country?: string;
  currency?: string;
  /** From vault.recipientInfo; null when the chain couldn't be read. */
  onChain: { allowed: boolean; monthlyCap: bigint; spentThisMonth: bigint } | null;
}

/** Addresses that must never become recipients of this vault. */
export interface Reserved {
  owner: Address;
  vault: Address;
  agent: Address | null;
}

export type Checked = { ok: true; recipient: NewRecipient } | { ok: false; error: string };

const fail = (error: string): Checked => ({ ok: false, error });

/** Checks the form before any wallet popup, with a message the owner can act on. */
export function checkNewRecipient(form: RecipientForm, existing: DirectoryEntry[], reserved: Reserved): Checked {
  const name = form.name.trim();
  if (!name) return fail("Give the recipient a name, so you can say \"Pay Ramon 50\".");
  if (name.length > NAME_MAX) return fail(`Keep the name under ${NAME_MAX} characters.`);
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(name)) return fail("Use a name without line breaks or invisible characters.");

  const rawAddress = form.address.trim();
  if (!isAddress(rawAddress, { strict: false })) return fail("That isn't a wallet address. It starts with 0x and has 40 more characters.");
  const address = getAddress(rawAddress);
  const same = (a: Address | null) => a !== null && a.toLowerCase() === address.toLowerCase();
  if (same(zeroAddress)) return fail("The zero address can't receive payments.");
  if (same(DEMO_ATTACK_ADDRESS)) return fail("The demo attack address can never be added as a recipient.");
  if (same(reserved.vault)) return fail("That's your vault's own address.");
  if (same(reserved.agent)) return fail("That's the agent's address. The agent must never be able to pay itself.");
  if (same(reserved.owner)) return fail("That's your own wallet. You can withdraw from the vault at any time instead.");

  const current = existing.find((r) => same(r.address));
  if (current && current.name.toLowerCase() !== name.toLowerCase()) return fail(`${current.name} already has this address. Review the name and address.`);
  const clash = existing.find((r) => !same(r.address) && r.name.toLowerCase() === name.toLowerCase());
  if (clash) return fail(`You already have a recipient named ${clash.name}. Use a different name.`);
  if (!current && existing.length >= 200) return fail("Your directory already has the maximum of 200 recipients.");

  const country = form.country.trim();
  if (country.length > COUNTRY_MAX) return fail(`Keep the country under ${COUNTRY_MAX} characters.`);
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(country)) return fail("Use a country without line breaks or invisible characters.");

  const currency = CURRENCIES.find((c) => c === form.currency);
  if (!currency) return fail(`Pick a currency: ${CURRENCIES.join(", ")}.`);

  const rawCap = form.monthlyCap.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(rawCap)) return fail("Write the monthly cap as a number, like 1000 or 250.5.");
  const monthlyCap = parseUnits(rawCap, 18);
  if (monthlyCap === 0n) return fail("The monthly cap must be more than 0, or the vault refuses every payment.");
  if (monthlyCap > CAP_MAX) return fail("That monthly cap is too large.");

  return { ok: true, recipient: { name, address, ...(country ? { country } : {}), currency, monthlyCap } };
}

export type DirectoryEntry = Omit<ListedRecipient, "onChain">;

export interface RecipientReview {
  recipient: NewRecipient;
  storedDetails?: Pick<ListedRecipient, "country" | "currency">;
  allowed: boolean;
  currentCap: bigint;
  action: "authorize" | "save-name" | "done";
}

interface RecipientReads {
  directory: () => Promise<DirectoryEntry[] | null>;
  authorization: (address: Address) => Promise<ListedRecipient["onChain"]>;
}

/** Both entry points read the directory and the target's actual authorization, including unnamed addresses. */
export async function reviewRecipient(form: RecipientForm, reserved: Reserved, reads: RecipientReads): Promise<RecipientReview> {
  const directory = await reads.directory();
  if (!directory) throw new Error("Couldn't verify the recipient directory. Try again.");
  const checked = checkNewRecipient(form, directory, reserved);
  if (!checked.ok) throw new Error(checked.error);
  const { recipient } = checked;
  const entry = directory.find((r) => r.address.toLowerCase() === recipient.address.toLowerCase());
  const authorization = await reads.authorization(recipient.address);
  if (!authorization) throw new Error("Couldn't verify this address in your vault. Try again.");
  const { allowed, monthlyCap } = authorization;
  const needsWallet = !allowed || monthlyCap !== recipient.monthlyCap;
  const detailsMatch = entry && entry.country === recipient.country && entry.currency === recipient.currency;
  return {
    recipient,
    storedDetails: entry && { country: entry.country, currency: entry.currency },
    allowed,
    currentCap: monthlyCap,
    action: needsWallet ? "authorize" : detailsMatch ? "done" : "save-name",
  };
}

type SaveOutcome =
  | { kind: "added" }
  | { kind: "changed"; review: RecipientReview }
  | { kind: "retry-name"; review: RecipientReview; error: string };

interface RecipientWrites {
  /** Resolves only after a successful receipt. */
  authorize: (recipient: NewRecipient) => Promise<void>;
  saveName: (recipient: NewRecipient, stored: RecipientReview["storedDetails"]) => Promise<void>;
}

function sameStoredDetails(a: RecipientReview, b: RecipientReview) {
  const left = a.storedDetails;
  const right = b.storedDetails;
  if (!left || !right) return left === right;
  return left.country === right.country && left.currency === right.currency;
}

/** A signature always applies to the state the owner reviewed. A name-only retry stays name-only. */
export async function saveReviewedRecipient(
  reviewed: RecipientReview,
  inspect: () => Promise<RecipientReview>,
  writes: RecipientWrites,
): Promise<SaveOutcome> {
  const fresh = await inspect();
  if (fresh.action === "done") return { kind: "added" };
  if (fresh.action !== reviewed.action || fresh.currentCap !== reviewed.currentCap ||
      fresh.allowed !== reviewed.allowed || !sameStoredDetails(fresh, reviewed)) {
    return { kind: "changed", review: fresh };
  }
  const { recipient } = fresh;
  const needsWallet = fresh.action === "authorize";
  if (needsWallet) await writes.authorize(recipient);
  const authorized: RecipientReview = { ...fresh, allowed: true, currentCap: recipient.monthlyCap, action: "save-name" };
  try {
    if (needsWallet) {
      // The wallet may have been open long enough for another tab to change the directory.
      const afterReceipt = await inspect();
      if (afterReceipt.action === "done") return { kind: "added" };
      if (afterReceipt.action !== "save-name" || !sameStoredDetails(afterReceipt, fresh)) {
        return { kind: "changed", review: afterReceipt };
      }
    }
    await writes.saveName(recipient, fresh.storedDetails);
    return { kind: "added" };
  } catch (cause) {
    return { kind: "retry-name", review: authorized, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
