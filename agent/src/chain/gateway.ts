import type { Address, Hex } from "viem";
import type { VaultRevert } from "./errors";

/** Mirrors ILeashVault.Rules. Amounts are 18-decimal token units. */
export interface Rules {
  perPaymentCap: bigint;
  dailyCap: bigint;
  cooldown: bigint;
  maxSlippageBps: bigint;
  dailySwapCap: bigint;
  minTokenPrice: bigint;
}

/** Mirrors ILeashVaultFactory.Config. */
export interface DeploymentConfig {
  usdt: Address;
  usdc: Address;
  usdtFeed: Address;
  usdcFeed: Address;
  maxPriceAge: bigint;
  tbill: Address;
  dex: Address;
  defaultAgent: Address;
}

export interface VaultSnapshot {
  vault: Address;
  owner: Address;
  agent: Address;
  paused: boolean;
  rules: Rules;
  spentToday: bigint;
  swappedToday: bigint;
  balances: { USDT: bigint; USDC: bigint; tbillValue: bigint };
}

/** One pay() call. `ref` is the plan's bytes32 reference. */
export interface PayStep {
  recipient: Address;
  token: Address;
  amount: bigint;
  ref: Hex;
}

export type ReceiptStatus = "success" | "reverted" | "pending" | "unknown";

/**
 * Everything the agent does on-chain goes through this interface, so tests can
 * swap in a fake and the rest of the agent never touches viem directly.
 */
export interface VaultGateway {
  /** The agent key's address, or null when AGENT_PRIVATE_KEY is not configured. */
  readonly agentAddress: Address | null;
  deployment(): Promise<DeploymentConfig>;
  vaultOf(owner: Address): Promise<Address | null>;
  snapshot(vault: Address): Promise<VaultSnapshot>;
  /** Runs pay() as a simulation. Returns the vault's refusal, or null if it would go through. */
  previewPay(vault: Address, step: PayStep): Promise<VaultRevert | null>;
  /** Simulates pay() and sends it. Throws VaultRevertError if the vault refuses in simulation. */
  sendPay(vault: Address, step: PayStep): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<"success" | "reverted">;
  receiptStatus(hash: Hex): Promise<ReceiptStatus>;
}
