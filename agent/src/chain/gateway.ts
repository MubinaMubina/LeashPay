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

/** What the chain says about a pay() transaction the agent signed. */
export type PaymentCheck =
  /** In a finalized block, and the vault emitted the matching Paid event. */
  | { status: "paid"; hash: Hex }
  /**
   * Reverted, or mined without paying. `hash` is always the agent's own transaction;
   * `replacedBy` names the one that took its nonce, when that happened.
   */
  | { status: "not_paid"; hash: Hex; reason: string; replacedBy?: Hex }
  /** Waiting to be mined, or mined but not final yet. */
  | { status: "pending" }
  /** The chain doesn't know this transaction: it never arrived, or was dropped. */
  | { status: "unknown" };

/** A pay() transaction signed by the agent key, not sent yet. Its hash is known before it is broadcast. */
export interface SignedPayment {
  hash: Hex;
  /** Sends it. If this throws, the network may or may not have received it; check the hash later. */
  broadcast(): Promise<void>;
  /** Gives back the nonce it reserved, when it will never be broadcast. */
  discard(): void;
}

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
  /**
   * Runs pay() as a simulation. Returns the vault's refusal, or null if it would go through.
   * `as` is the vault's agent, the caller to simulate when no agent key is configured.
   */
  previewPay(vault: Address, step: PayStep, as: Address): Promise<VaultRevert | null>;
  /** Simulates pay() and signs it without sending. Throws VaultRevertError if the vault refuses. */
  signPay(vault: Address, step: PayStep): Promise<SignedPayment>;
  /** Waits, up to a time limit, until the transaction (or one that replaced it) is final. */
  waitForPayment(vault: Address, step: PayStep, hash: Hex): Promise<PaymentCheck>;
  /** Looks once, without waiting. */
  checkPayment(vault: Address, step: PayStep, hash: Hex): Promise<PaymentCheck>;
  /**
   * True when the vault, as of the latest finalized block, already counts this payment
   * as made (its DuplicatePayment check). Proves a payment the journal has no hash for.
   */
  paidAsOfFinality(vault: Address, step: PayStep): Promise<boolean>;
}
