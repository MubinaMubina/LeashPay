import type { Address } from "viem";
import { DEMO_ATTACK_ADDRESS, FUNDING_MINIMUM, FUNDING_TARGET, type DemoRecipient } from "./demo";

/**
 * Vault setup that can always be re-run (D10). Each pass reads what already exists and
 * plans only the missing steps, so a closed wallet popup or a network hiccup halfway
 * leaves a state the next pass finishes, never a broken one.
 *
 *   read state ─► planOnboarding ─► run the first step ─► read state again ─► … ─► nothing missing
 */

export type Coin = "USDT" | "USDC";

export interface RecipientState {
  recipient: DemoRecipient;
  /** On the vault's allowlist, from vault.recipientInfo. */
  allowed: boolean;
  monthlyCap: bigint;
  /** In the agent's directory for this owner (names for the planner). */
  inDirectory: boolean;
}

export interface OnboardingState {
  /** factory.vaultOf(owner); null when the owner has no vault yet. */
  vault: Address | null;
  recipients: RecipientState[];
  balances: Record<Coin, bigint>;
}

export type OnboardingStep =
  | { kind: "createVault" }
  | { kind: "allowRecipient"; recipient: DemoRecipient }
  | { kind: "addToDirectory"; recipient: DemoRecipient }
  | { kind: "fund"; coin: Coin; amount: bigint };

/** The steps still missing, in the order they must run. Empty means setup is complete. */
export function planOnboarding(state: OnboardingState): OnboardingStep[] {
  // Everything else lives in the vault, so nothing else can be planned until it exists.
  if (!state.vault) return [{ kind: "createVault" }];

  const steps: OnboardingStep[] = [];
  for (const { recipient, allowed, monthlyCap, inDirectory } of state.recipients) {
    assertNotAttackAddress(recipient.address);
    if (!allowed || monthlyCap < recipient.monthlyCap) steps.push({ kind: "allowRecipient", recipient });
    if (!inDirectory) steps.push({ kind: "addToDirectory", recipient });
  }
  for (const coin of ["USDT", "USDC"] as const) {
    const balance = state.balances[coin];
    // Payments spend the balance down; only a coin that runs low is topped up, so normal
    // use never sends the owner back to setup.
    if (balance < FUNDING_MINIMUM) steps.push({ kind: "fund", coin, amount: FUNDING_TARGET - balance });
  }
  return steps;
}

/** The demo attack's target must never be allowlisted (D15): refuse before any wallet popup. */
export function assertNotAttackAddress(address: Address): void {
  if (address.toLowerCase() === DEMO_ATTACK_ADDRESS.toLowerCase()) {
    throw new Error("The demo attack address can never be added as a recipient.");
  }
}

/** A short label for the setup checklist. */
export function describeStep(step: OnboardingStep): string {
  switch (step.kind) {
    case "createVault":
      return "Create your vault";
    case "allowRecipient":
      return `Allow ${step.recipient.name} in the vault`;
    case "addToDirectory":
      return `Add ${step.recipient.name} to the agent's recipient list`;
    case "fund":
      return `Get test ${step.coin} for the vault`;
  }
}
