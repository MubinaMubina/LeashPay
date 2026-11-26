import { getAddress, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { DEMO_ATTACK_ADDRESS } from "./demo";
import { FX_CURRENCIES } from "./fx";

/**
 * Adding a recipient from the dashboard. Two writes, in this order:
 *
 *   1. vault.setRecipient(address, true, monthlyCap)   owner's wallet: who can be paid, and how much
 *   2. POST /api/directory { name, address, ... }      the agent's address book: who "Ramon" is
 *
 * The vault is first so the agent never knows a name the vault would refuse. Both writes
 * can be repeated safely, so an add interrupted between them is finished by submitting again.
 */

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
export function checkNewRecipient(form: RecipientForm, existing: ListedRecipient[], reserved: Reserved): Checked {
  const name = form.name.trim();
  if (!name) return fail("Give the recipient a name, so you can say \"Pay Ramon 50\".");
  if (name.length > NAME_MAX) return fail(`Keep the name under ${NAME_MAX} characters.`);

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
  if (current?.onChain?.allowed) return fail(`${current.name} already has this address.`);
  const clash = existing.find((r) => !same(r.address) && r.name.toLowerCase() === name.toLowerCase());
  if (clash) return fail(`You already have a recipient named ${clash.name}. Use a different name.`);

  const country = form.country.trim();
  if (country.length > COUNTRY_MAX) return fail(`Keep the country under ${COUNTRY_MAX} characters.`);

  const currency = CURRENCIES.find((c) => c === form.currency);
  if (!currency) return fail(`Pick a currency: ${CURRENCIES.join(", ")}.`);

  const rawCap = form.monthlyCap.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(rawCap)) return fail("Write the monthly cap as a number, like 1000 or 250.5.");
  const monthlyCap = parseUnits(rawCap, 18);
  if (monthlyCap === 0n) return fail("The monthly cap must be more than 0, or the vault refuses every payment.");
  if (monthlyCap > CAP_MAX) return fail("That monthly cap is too large.");

  return { ok: true, recipient: { name, address, ...(country ? { country } : {}), currency, monthlyCap } };
}
