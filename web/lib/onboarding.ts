import type { Address } from "viem";
import { FUNDING_MINIMUM, FUNDING_TARGET } from "./demo";

/**
 * Vault setup that can always be re-run (D10). Each pass reads what already exists and
 * plans only the missing steps, so a closed wallet popup or a network hiccup halfway
 * leaves a state the next pass finishes, never a broken one.
 *
 *   read state ─► planOnboarding ─► run the first step ─► read state again ─► … ─► nothing missing
 */

export type Coin = "USDT" | "USDC";

export interface OnboardingState {
  /** factory.vaultOf(owner); null when the owner has no vault yet. */
  vault: Address | null;
  balances: Record<Coin, bigint>;
}

export type OnboardingStep =
  | { kind: "createVault" }
  | { kind: "fund"; coin: Coin; amount: bigint };

/** The steps still missing, in the order they must run. Empty means setup is complete. */
export function planOnboarding(state: OnboardingState): OnboardingStep[] {
  // Everything else lives in the vault, so nothing else can be planned until it exists.
  if (!state.vault) return [{ kind: "createVault" }];

  const steps: OnboardingStep[] = [];
  for (const coin of ["USDT", "USDC"] as const) {
    const balance = state.balances[coin];
    // Payments spend the balance down; only a coin that runs low is topped up, so normal
    // use never sends the owner back to setup.
    if (balance < FUNDING_MINIMUM) steps.push({ kind: "fund", coin, amount: FUNDING_TARGET - balance });
  }
  return steps;
}

/** A short label for the setup checklist. */
export function describeStep(step: OnboardingStep): string {
  switch (step.kind) {
    case "createVault":
      return "Create your vault";
    case "fund":
      return `Get test ${step.coin} for the vault`;
  }
}
