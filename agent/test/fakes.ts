import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddress, pad, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VaultRevertError, describeVaultError, type VaultRevert } from "../src/chain/errors";
import type {
  DeploymentConfig,
  PayStep,
  PaymentCheck,
  SignedPayment,
  VaultGateway,
  VaultSnapshot,
} from "../src/chain/gateway";

// Checksummed (EIP-55), like every address the agent produces.
const addr = (hex: string) => getAddress(hex) as Address;
/** The vault owner's wallet: a throwaway key made for each test run, so approvals are really signed. */
export const OWNER_ACCOUNT = privateKeyToAccount(generatePrivateKey());
export const OWNER = OWNER_ACCOUNT.address;
/** Someone who is not the owner. */
export const STRANGER_ACCOUNT = privateKeyToAccount(generatePrivateKey());
export const VAULT = addr("0x00000000000000000000000000000000000000b2");
export const AGENT = addr("0x00000000000000000000000000000000000000c3");
export const LINH = addr("0x1111111111111111111111111111111111111111");
export const MARCO = addr("0x2222222222222222222222222222222222222222");
export const ATTACKER = addr("0xbad0000000000000000000000000000000000bad");
export const USDT = addr("0x00000000000000000000000000000000000000d4");
export const USDC = addr("0x00000000000000000000000000000000000000e5");

/** How the agent abbreviates an address in messages. */
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "leashpay-agent-"));
}

export const refusal = (name: string, args: unknown[] = []): VaultRevert => describeVaultError(name, args);

/**
 * In-memory stand-in for the vault and the chain. It doesn't re-implement the
 * vault's rules: tests say which recipients the vault refuses and what the chain
 * answers about each transaction.
 */
export class FakeGateway implements VaultGateway {
  agentAddress: Address | null = AGENT;
  /** Payments that were broadcast, in order. */
  readonly sent: PayStep[] = [];
  /** recipient -> the refusal the vault gives in simulation */
  readonly refusals = new Map<Address, VaultRevert>();
  /** hash -> what a single look at the chain answers (missing: "unknown"). Broadcasts land as "paid". */
  readonly chain = new Map<Hex, PaymentCheck>();
  /** hash -> what waiting for the transaction ends with, when it differs from a single look. */
  readonly settles = new Map<Hex, PaymentCheck>();
  /** The next broadcast throws this, after the transaction was signed and journaled. */
  broadcastError: Error | null = null;
  /** With broadcastError: the transaction reached the network anyway (only the reply was lost). */
  broadcastLanded = false;
  /** When set, waitForPayment waits on this promise first (to hold a plan mid-run). */
  hold: Promise<void> | null = null;
  /** Whether a DuplicatePayment refusal also holds at the finalized block. */
  duplicateIsFinal = true;
  /** Hashes of signed payments whose nonce was given back without broadcasting. */
  readonly discarded: Hex[] = [];
  vault: Address | null = VAULT;
  private signed = 0;

  async deployment(): Promise<DeploymentConfig> {
    return {
      usdt: USDT,
      usdc: USDC,
      usdtFeed: USDT,
      usdcFeed: USDC,
      maxPriceAge: 3600n,
      tbill: USDT,
      dex: USDT,
      defaultAgent: AGENT,
    };
  }

  async vaultOf(): Promise<Address | null> {
    return this.vault;
  }

  async snapshot(vault: Address): Promise<VaultSnapshot> {
    return {
      vault,
      owner: OWNER,
      agent: AGENT,
      paused: false,
      rules: {
        perPaymentCap: 1000n * 10n ** 18n,
        dailyCap: 2000n * 10n ** 18n,
        cooldown: 0n,
        maxSlippageBps: 100n,
        dailySwapCap: 1000n * 10n ** 18n,
        minTokenPrice: 0n,
      },
      spentToday: 0n,
      swappedToday: 0n,
      balances: { USDT: 5000n * 10n ** 18n, USDC: 0n, tbillValue: 0n },
    };
  }

  async previewPay(_vault: Address, step: PayStep): Promise<VaultRevert | null> {
    return this.refusals.get(step.recipient) ?? null;
  }

  async signPay(_vault: Address, step: PayStep): Promise<SignedPayment> {
    const refused = this.refusals.get(step.recipient);
    if (refused) throw new VaultRevertError(refused);
    const hash = pad(toHex(++this.signed), { size: 32 });
    return {
      hash,
      broadcast: async () => {
        const error = this.broadcastError;
        this.broadcastError = null;
        if (!error || this.broadcastLanded) {
          this.sent.push(step);
          if (!this.chain.has(hash)) this.chain.set(hash, { status: "paid", hash });
        }
        if (error) throw error;
      },
      discard: () => {
        this.discarded.push(hash);
      },
    };
  }

  async paidAsOfFinality(_vault: Address, step: PayStep): Promise<boolean> {
    return this.refusals.get(step.recipient)?.name === "DuplicatePayment" && this.duplicateIsFinal;
  }

  async waitForPayment(_vault: Address, _step: PayStep, hash: Hex): Promise<PaymentCheck> {
    if (this.hold) await this.hold;
    return this.settles.get(hash) ?? this.chain.get(hash) ?? { status: "pending" };
  }

  async checkPayment(_vault: Address, _step: PayStep, hash: Hex): Promise<PaymentCheck> {
    return this.chain.get(hash) ?? { status: "unknown" };
  }
}
