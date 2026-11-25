import type { Address, Hex } from "viem";
import type { Plan, PlannedPayment } from "./plan/build";

/** JSON.stringify replacer: bigints become decimal strings. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Recursively turns bigints into strings, for API responses. */
export function toJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, bigintReplacer));
}

type PaymentJson = Omit<PlannedPayment, "amount"> & { amount: string | null };
export type PlanJson = Omit<Plan, "payments"> & { payments: PaymentJson[] };

/** Reverses toJson for a Plan read back from the journal. */
export function planFromJson(json: PlanJson): Plan {
  return {
    ...json,
    owner: json.owner as Address,
    vault: json.vault as Address | null,
    ref: json.ref as Hex,
    payments: json.payments.map((p) => ({ ...p, amount: p.amount === null ? null : BigInt(p.amount) })),
  };
}
