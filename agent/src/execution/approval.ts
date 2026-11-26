import { formatUnits, verifyMessage, type Address, type Hex } from "viem";
import { isCalendarDate, isExecutable, type Plan } from "../plan/build";
import { oneLine } from "../validation";

/** How long an owner's signed approval stays valid. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalTerms {
  /** ISO timestamp after which the signature no longer runs the plan. */
  expires: string;
  /** The owner chose to pay before the plan's scheduled date. */
  payEarly: boolean;
}

/**
 * The exact text the owner signs with their wallet (EIP-191 personal_sign) to run
 * a plan. It names the plan, its on-chain reference, the vault, every payment with
 * anything the agent flagged about it, and an expiry, so the wallet prompt shows what
 * is being approved and a signature for one plan can't run another. The server
 * rebuilds this text from the stored plan to check a signature; it never parses text
 * a caller sends.
 */
export function approvalMessage(plan: Plan, terms: ApprovalTerms): string {
  const payments = plan.payments.filter(isExecutable).flatMap((p) => [
    `- ${formatUnits(p.amount, 18)} ${p.token} to ${oneLine(p.recipientName)} (${p.recipient})`,
    ...p.warnings.map((w) => `  check: ${oneLine(w, 200)}`),
  ]);
  const passed = isCalendarDate(plan.scheduledFor) && plan.scheduledFor < plan.createdAt.slice(0, 10);
  const feeLines: string[] = [];
  if (plan.paymentFee) {
    const payable = plan.payments.filter(isExecutable);
    const fee = BigInt(plan.paymentFee.amount);
    const maximumFee = fee * BigInt(payable.length);
    const totals = { USDT: maximumFee, USDC: 0n };
    for (const payment of payable) totals[payment.token] += payment.amount;
    const debits = (["USDT", "USDC"] as const).filter((token) => totals[token] > 0n)
      .map((token) => `${formatUnits(totals[token], 18)} ${token}`);
    feeLines.push(
      `Service fee: ${formatUnits(fee, 18)} USDT per successful payment to ${plan.paymentFee.recipient}`,
      `Maximum service fees: ${formatUnits(maximumFee, 18)} USDT`,
      `Maximum vault debit: ${debits.join(" + ") || "0 USDT"}`,
    );
  }
  return [
    "LeashPay: approve this payment plan",
    `Plan: ${plan.id}`,
    `Reference: ${plan.ref}`,
    `Vault: ${plan.vault}`,
    "Network: BNB Smart Chain Testnet (chain 97)",
    "Payments:",
    ...(payments.length > 0 ? payments : ["- none"]),
    ...feeLines,
    // The plan's notes (Claude's warnings, totals over today's limit) reach the wallet prompt too.
    ...(plan.notes.length > 0 ? ["Notes:", ...plan.notes.map((note) => `- ${oneLine(note, 200)}`)] : []),
    `Scheduled for: ${oneLine(plan.scheduledFor, 40)}${passed ? " (already past when this plan was made)" : ""}`,
    ...(terms.payEarly ? ["Pay before the scheduled date: yes"] : []),
    `Valid until: ${terms.expires}`,
  ].join("\n");
}

/**
 * True when `owner` signed `message` with a plain wallet (an EOA, which Privy's
 * embedded wallets are). Checked locally by recovering the signer: no RPC is asked,
 * so a dishonest node can't vouch for a forged signature. Anything that isn't a
 * valid signature is simply not the owner's.
 */
export async function signedByOwner(owner: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    return await verifyMessage({ address: owner, message, signature });
  } catch {
    return false;
  }
}
