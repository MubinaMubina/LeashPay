import type { ListedRecipient } from "./recipients";

export interface VaultBalances {
  USDT: string;
  USDC: string;
  tbillValue: string;
}

const isBaseUnits = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);

/** The vault reader returns 18-decimal base units as strings, including "0". */
export function parseVaultBalances(value: unknown): VaultBalances | null {
  if (!value || typeof value !== "object") return null;
  if (!("USDT" in value && "USDC" in value && "tbillValue" in value)) return null;
  const { USDT, USDC, tbillValue } = value;
  return isBaseUnits(USDT) && isBaseUnits(USDC) && isBaseUnits(tbillValue) ? { USDT, USDC, tbillValue } : null;
}

const PAGE_SIZE = 3;
const byName = new Intl.Collator("en", { sensitivity: "base" });

export function recipientPage(list: readonly ListedRecipient[], requestedPage: number) {
  const allowed = list.flatMap(({ name, address, onChain }) =>
    name.trim() && onChain?.allowed ? [{ name, address, cap: onChain.monthlyCap }] : [],
  );
  allowed.sort((left, right) => byName.compare(left.name, right.name) || left.address.localeCompare(right.address));
  const total = allowed.length;
  const page = Math.max(0, Math.min(requestedPage, Math.ceil(total / PAGE_SIZE) - 1));
  const start = page * PAGE_SIZE;
  const rows = allowed.slice(start, start + PAGE_SIZE);
  return {
    rows, total, page,
    first: total ? start + 1 : 0,
    last: start + rows.length,
    hasNext: start + rows.length < total,
    unverified: list.some((entry) => entry.name.trim() && entry.onChain === null),
  };
}
