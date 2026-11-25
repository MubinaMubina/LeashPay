import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAddress, pad, toHex, type Address, type Hex } from "viem";
import { VaultRevertError, describeVaultError, type VaultRevert } from "../src/chain/errors";
import type { DeploymentConfig, PayStep, ReceiptStatus, VaultGateway, VaultSnapshot } from "../src/chain/gateway";

// Checksummed (EIP-55), like every address the agent produces.
const addr = (hex: string) => getAddress(hex) as Address;
export const OWNER = addr("0x00000000000000000000000000000000000000a1");
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
 * In-memory stand-in for the vault. It doesn't re-implement the vault's rules:
 * tests tell it which recipients to refuse and what each receipt looks like.
 */
export class FakeGateway implements VaultGateway {
  readonly agentAddress: Address | null = AGENT;
  readonly sent: PayStep[] = [];
  readonly receipts = new Map<Hex, ReceiptStatus>();
  /** recipient -> refusal the vault gives in simulation */
  readonly refusals = new Map<Address, VaultRevert>();
  /** When set, waitForReceipt waits on this promise first (to hold a plan mid-run). */
  hold: Promise<void> | null = null;
  vault: Address | null = VAULT;

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

  async sendPay(_vault: Address, step: PayStep): Promise<Hex> {
    const refused = this.refusals.get(step.recipient);
    if (refused) throw new VaultRevertError(refused);
    this.sent.push(step);
    const hash = pad(toHex(this.sent.length), { size: 32 });
    this.receipts.set(hash, "success");
    return hash;
  }

  async waitForReceipt(hash: Hex): Promise<"success" | "reverted"> {
    if (this.hold) await this.hold;
    return this.receipts.get(hash) === "reverted" ? "reverted" : "success";
  }

  async receiptStatus(hash: Hex): Promise<ReceiptStatus> {
    return this.receipts.get(hash) ?? "unknown";
  }
}
