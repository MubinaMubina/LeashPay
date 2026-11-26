/** Demo assumption until a bank transfer provider supplies its own fee quote. */
export const PREVIEW_FEE_PERCENT = 1;

export function estimateBankTransfer(bankUsd: number, direction: "deposit" | "withdraw") {
  const bankCents = Math.round(bankUsd * 100);
  const feeCents = Math.round(bankCents * PREVIEW_FEE_PERCENT / 100);
  const vaultCents = direction === "deposit" ? bankCents - feeCents : bankCents + feeCents;
  return { feeUsd: feeCents / 100, vaultUsd: vaultCents / 100 };
}
