import { formatUnits } from "viem";

/** The agent's JSON for a plan (agent/src/json.ts), only the fields the page reads. */
export interface VaultRevertJson {
  name: string;
  args: string[];
  message: string;
}

export interface PaymentJson {
  recipientName: string;
  recipient: string | null;
  amount: string | null;
  token: "USDT" | "USDC";
  warnings: string[];
  /** null: the vault's check passed. An error: the vault refuses. Missing: the check couldn't run. */
  preview?: VaultRevertJson | null;
  /** The amount in the recipient's local currency (CoinMarketCap), when they have one. Display only. */
  local?: LocalAmountJson;
}

export type LocalAmountJson =
  | { currency: string; amount: number; rate: number; quotedAt: string; source: string }
  | { currency: string; error: string };

export type DepegJson =
  | {
      available: true;
      claim: string;
      marketId: string;
      marketTitle: string;
      probability: number;
      threshold: number;
      chosenToken: "USDT" | "USDC";
      sources: { title: string; url?: string; time?: string }[];
      fetchedAt: string;
      requestId: string | null;
    }
  | { available: false; threshold: number; reason: string };

/** The guard's decision plus its sentence (the one in the signed text). Older plans have no `note`. */
export type PlanDepegJson = DepegJson & { note?: string };

export interface PlanJson {
  id: string;
  ref: string;
  owner: string;
  vault: string | null;
  message: string;
  kind: string;
  scheduledFor: string;
  payments: PaymentJson[];
  notes: string[];
  createdAt: string;
  /** The depeg guard's decision (Cournot), when it ran. */
  depeg?: PlanDepegJson;
}

export type JournalEventJson =
  | { type: "step_sent"; at: string; index: number; hash: string }
  | { type: "step_succeeded"; at: string; index: number; hash: string | null; note?: string }
  | { type: "step_failed"; at: string; index: number; hash: string | null; error: string }
  | { type: "step_refused"; at: string; index: number; error: VaultRevertJson }
  | { type: "plan_created" | "plan_finished" | "approval_used"; at: string };

export interface PaymentResultJson {
  index: number;
  status: "paid" | "pending" | "refused" | "failed" | "skipped";
  hash?: string | null;
  error?: VaultRevertJson | string;
  note?: string;
}

export type Tone = "pass" | "stop" | "busy" | "muted";

export interface RowStatus {
  label: string;
  tone: Tone;
  /** The payment's transaction, when there is one to link to. */
  hash?: string;
  /** Why, for refusals and failures. */
  detail?: string;
}

/** After this long without a final event, "Sending…" becomes "Still confirming…". */
export const SLOW_AFTER_MS = 5_000;

export const isExecutable = (payment: PaymentJson) => Boolean(payment.recipient && payment.amount);

const errorDetail = (error: VaultRevertJson | string) => (typeof error === "string" ? error : error.message);
const errorName = (error: VaultRevertJson | string) => (typeof error === "string" ? "Failed" : `Refused: ${error.name}`);

/**
 * What one payment row shows. Final journal events win; then the results of a finished
 * run; then a payment still on its way; and before any run, the vault's check (preview).
 */
export function rowStatus(
  payment: PaymentJson,
  index: number,
  events: readonly JournalEventJson[],
  now: number,
  results?: readonly PaymentResultJson[],
): RowStatus {
  if (!isExecutable(payment)) return { label: "Can't be paid", tone: "muted", detail: payment.warnings.join(" ") || undefined };

  const mine = events.filter((e): e is Extract<JournalEventJson, { index: number }> => "index" in e && e.index === index);
  const last = mine.at(-1);
  if (last?.type === "step_succeeded") return { label: "Paid ✓", tone: "pass", hash: last.hash ?? undefined, detail: last.note };
  if (last?.type === "step_refused") return { label: errorName(last.error), tone: "stop", detail: errorDetail(last.error) };
  if (last?.type === "step_failed") return { label: "Failed", tone: "stop", hash: last.hash ?? undefined, detail: last.error };

  const result = results?.find((r) => r.index === index);
  if (result?.status === "pending") return { label: "Still confirming…", tone: "busy", hash: result.hash ?? undefined, detail: result.note };
  if (result?.status === "paid") return { label: "Paid ✓", tone: "pass", hash: result.hash ?? undefined };
  if (result?.status === "refused" && result.error) return { label: errorName(result.error), tone: "stop", detail: errorDetail(result.error) };
  if (result?.status === "failed") return { label: "Failed", tone: "stop", detail: result.error ? errorDetail(result.error) : undefined };

  if (last?.type === "step_sent") {
    const slow = now - Date.parse(last.at) > SLOW_AFTER_MS;
    return { label: slow ? "Still confirming…" : "Sending…", tone: "busy", hash: last.hash };
  }

  if (payment.preview === null) return { label: "Vault check passes", tone: "pass" };
  if (payment.preview) return { label: `Vault refuses: ${payment.preview.name}`, tone: "stop", detail: payment.preview.message };
  return { label: "Vault check unavailable", tone: "muted", detail: "The vault couldn't be asked just now; it checks again when the plan runs." };
}

/** A run left something unsettled, so "Check again" (a fresh signature on the same plan) is offered. */
export const needsCheckAgain = (results: readonly PaymentResultJson[] | undefined) => Boolean(results?.some((r) => r.status === "pending"));

/** "300 USDT" from 18-decimal base units. */
export function formatAmount(amount: string | null, token: string): string {
  if (!amount) return "—";
  const value = Number(formatUnits(BigInt(amount), 18));
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${token}`;
}

/** The currency's own decimals: none for VND, two for PHP and THB. */
function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "≈ 7,752,700 VND", or null when there is no local amount to show. */
export function formatLocal(local: LocalAmountJson | undefined): string | null {
  if (!local || "error" in local || !Number.isFinite(local.amount)) return null;
  const digits = currencyDigits(local.currency);
  return `≈ ${local.amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${local.currency}`;
}

/** The oldest rate time among the plan's local amounts (ISO), or null when none has a rate. */
export function localQuotedAt(payments: PaymentJson[]): string | null {
  const times = payments.flatMap((p) => (p.local && !("error" in p.local) ? [p.local.quotedAt] : []));
  return times.length > 0 ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}
