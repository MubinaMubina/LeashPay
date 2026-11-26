import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddressEqual,
  keccak256,
  nonceManager,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { leashVaultAbi, leashVaultFactoryAbi } from "../abi/generated";
import { ConfigurationError, type Config } from "../config";
import { VaultRevertError, decodeRevert, type TokenNames, type VaultRevert } from "./errors";
import type { AttackOutcome, DeploymentConfig, PayStep, PaymentCheck, SignedPayment, VaultGateway, VaultSnapshot } from "./gateway";

type AgentWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

// viem's bscTestnet entry has no blockTime, so viem would poll every 4 s. Testnet
// blocks come about every 0.45 s (measured), so poll at viem's 500 ms floor.
const POLLING_INTERVAL_MS = 500;
/** How long to wait for one payment to be mined and final before calling it pending. */
const RECEIPT_TIMEOUT_MS = 30_000;
/** Headroom on the gas estimate, in case the vault's state moves between estimate and mining. */
const GAS_HEADROOM_PERCENT = 20n;
/** How long the demo attack waits for its block to become final after the receipt. */
const FINALITY_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** BSC testnet clients. The wallet exists only when AGENT_PRIVATE_KEY is set. */
export function createChainClients(config: Pick<Config, "BSC_TESTNET_RPC_URL" | "AGENT_PRIVATE_KEY">) {
  // batch: reads made in the same tick share one HTTP request (the public RPC accepts JSON-RPC batches).
  const transport = http(config.BSC_TESTNET_RPC_URL, { batch: true });
  const publicClient = createPublicClient({ chain: bscTestnet, transport, pollingInterval: POLLING_INTERVAL_MS });
  const walletClient = config.AGENT_PRIVATE_KEY
    ? createWalletClient({
        // nonceManager lets the agent send payments back to back without nonce clashes.
        account: privateKeyToAccount(config.AGENT_PRIVATE_KEY, { nonceManager }),
        chain: bscTestnet,
        transport,
      })
    : null;
  return { publicClient, walletClient };
}

/**
 * Decides whether a mined transaction made this payment. A receipt alone isn't
 * enough: if another transaction from the agent key took the same nonce, viem
 * hands back that replacement's receipt. Only the vault's own Paid event for this
 * exact recipient, token, amount and ref counts.
 */
export function judgePayment(
  vault: Address,
  step: PayStep,
  receipt: Pick<TransactionReceipt, "status" | "transactionHash" | "logs">,
): PaymentCheck {
  if (receipt.status !== "success") {
    return { status: "not_paid", hash: receipt.transactionHash, reason: "The transaction reverted on-chain." };
  }
  const paid = parseEventLogs({ abi: leashVaultAbi, eventName: "Paid", logs: receipt.logs }).some(
    (log) =>
      isAddressEqual(log.address, vault) &&
      isAddressEqual(log.args.recipient, step.recipient) &&
      isAddressEqual(log.args.token, step.token) &&
      log.args.amount === step.amount &&
      log.args.ref.toLowerCase() === step.ref.toLowerCase(),
  );
  return paid
    ? { status: "paid", hash: receipt.transactionHash }
    : { status: "not_paid", hash: receipt.transactionHash, reason: "The transaction went through without making this payment." };
}

export class ViemVaultGateway implements VaultGateway {
  private deploymentPromise: Promise<DeploymentConfig> | null = null;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: AgentWallet | null,
    private readonly factory: Address | null,
  ) {}

  get agentAddress(): Address | null {
    return this.walletClient?.account.address ?? null;
  }

  deployment(): Promise<DeploymentConfig> {
    if (!this.deploymentPromise) {
      this.deploymentPromise = this.publicClient
        .readContract({ address: this.requireFactory(), abi: leashVaultFactoryAbi, functionName: "config" })
        .catch((err: unknown) => {
          this.deploymentPromise = null; // don't cache a failure
          throw err;
        });
    }
    return this.deploymentPromise;
  }

  async vaultOf(owner: Address): Promise<Address | null> {
    const vault = await this.publicClient.readContract({
      address: this.requireFactory(),
      abi: leashVaultFactoryAbi,
      functionName: "vaultOf",
      args: [owner],
    });
    return vault === zeroAddress ? null : vault;
  }

  async snapshot(vault: Address): Promise<VaultSnapshot> {
    const { usdt, usdc } = await this.deployment();
    const v = { address: vault, abi: leashVaultAbi } as const;
    const read = this.publicClient;
    const [owner, agent, paused, rules, spentToday, swappedToday, tbillValue, usdtBalance, usdcBalance] =
      await Promise.all([
        read.readContract({ ...v, functionName: "owner" }),
        read.readContract({ ...v, functionName: "agent" }),
        read.readContract({ ...v, functionName: "paused" }),
        read.readContract({ ...v, functionName: "rules" }),
        read.readContract({ ...v, functionName: "spentToday" }),
        read.readContract({ ...v, functionName: "swappedToday" }),
        read.readContract({ ...v, functionName: "tbillValue" }),
        read.readContract({ address: usdt, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
        read.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
      ]);
    return {
      vault,
      owner,
      agent,
      paused,
      rules,
      spentToday,
      swappedToday,
      balances: { USDT: usdtBalance, USDC: usdcBalance, tbillValue },
    };
  }

  async previewPay(vault: Address, step: PayStep, as: Address): Promise<VaultRevert | null> {
    const account = this.walletClient?.account ?? as;
    try {
      await this.publicClient.simulateContract({ ...payCall(vault, step), account });
      return null;
    } catch (err) {
      const revert = decodeRevert(err, await this.tokenNames());
      if (revert) return revert;
      throw err;
    }
  }

  async signPay(vault: Address, step: PayStep): Promise<SignedPayment> {
    const wallet = this.requireWallet();
    const { account } = wallet;
    const call = { ...payCall(vault, step), account };

    // Both run pay() against the full vault ABI, so a refusal comes back decoded
    // (prepareTransactionRequest below only sees raw calldata, with the gas already set).
    let gas: bigint;
    try {
      await this.publicClient.simulateContract(call);
      gas = await this.publicClient.estimateContractGas(call);
    } catch (err) {
      const revert = decodeRevert(err, await this.tokenNames());
      if (revert) throw new VaultRevertError(revert);
      throw err;
    }

    return this.signWithGas(vault, step, gas + (gas * GAS_HEADROOM_PERCENT) / 100n);
  }

  async signPayUnchecked(vault: Address, step: PayStep, gas: bigint): Promise<SignedPayment> {
    return this.signWithGas(vault, step, gas);
  }

  /** Signs pay() with the given gas limit. The one place payments take a nonce, so both paths share it. */
  private async signWithGas(vault: Address, step: PayStep, gas: bigint): Promise<SignedPayment> {
    const wallet = this.requireWallet();
    const { account } = wallet;
    const call = { ...payCall(vault, step), account };
    let serializedTransaction: Hex;
    try {
      const request = await wallet.prepareTransactionRequest({
        account,
        chain: bscTestnet,
        to: vault,
        data: encodeFunctionData({ abi: leashVaultAbi, functionName: "pay", args: call.args }),
        gas,
        nonceManager: account.nonceManager,
      });
      serializedTransaction = await wallet.signTransaction(request);
    } catch (err) {
      this.resetNonce(); // the nonce it took was never used
      throw err;
    }

    return {
      hash: keccak256(serializedTransaction),
      broadcast: async () => {
        try {
          await wallet.sendRawTransaction({ serializedTransaction });
        } catch (err) {
          if (err instanceof BaseError && /already known/i.test(`${err.details} ${err.shortMessage}`)) return;
          this.resetNonce(); // let the next send ask the chain which nonce is really next
          throw err;
        }
      },
      discard: () => this.resetNonce(),
    };
  }

  async waitForPayment(vault: Address, step: PayStep, hash: Hex): Promise<PaymentCheck> {
    const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
    let mined: TransactionReceipt;
    try {
      // If another transaction took this one's nonce, this resolves with that one's receipt.
      mined = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) return { status: "pending" };
      throw err;
    }
    // That first receipt may come from a block a reorganization later replaces, so it
    // is never judged itself: once its block could be final, ask the chain again.
    for (;;) {
      const check = await this.checkPayment(vault, step, mined.transactionHash);
      if (check.status !== "pending") {
        if (mined.transactionHash === hash || check.status !== "not_paid") return check;
        return {
          status: "not_paid",
          hash,
          replacedBy: mined.transactionHash,
          reason: "Another transaction from the agent key took this one's place without making this payment.",
        };
      }
      if (Date.now() >= deadline) return { status: "pending" };
      await sleep(POLLING_INTERVAL_MS);
    }
  }

  async checkPayment(vault: Address, step: PayStep, hash: Hex): Promise<PaymentCheck> {
    // Finalized block first: a receipt read after it, at or below its height, is in the
    // final chain, because finalized blocks never change.
    const finalized = await this.publicClient.getBlock({ blockTag: "finalized" });
    let receipt: TransactionReceipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash });
    } catch (err) {
      if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
      try {
        await this.publicClient.getTransaction({ hash });
        return { status: "pending" };
      } catch (lookupErr) {
        if (!(lookupErr instanceof TransactionNotFoundError)) throw lookupErr;
        // Never arrived, or dropped: its nonce is free again. Without this reset, viem's
        // nonce manager would give the resend the next nonce and leave a gap that stalls
        // every later transaction from the agent key.
        this.resetNonce();
        return { status: "unknown" };
      }
    }
    if (receipt.blockNumber > finalized.number) return { status: "pending" };
    // A load-balanced node can answer from a fork that lost: the receipt counts only if
    // its block is the one the chain has at that height.
    const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) return { status: "pending" };
    return judgePayment(vault, step, receipt);
  }

  async paidAsOfFinality(vault: Address, step: PayStep): Promise<boolean> {
    // The public BSC testnet node refuses state reads at the "finalized" tag ("missing trie
    // node"), but answers at that block's number.
    const finalized = await this.publicClient.getBlock({ blockTag: "finalized" });
    try {
      await this.publicClient.simulateContract({
        ...payCall(vault, step),
        account: this.requireWallet().account,
        blockNumber: finalized.number,
      });
      return false; // the finalized state would still accept it: not paid there (yet)
    } catch (err) {
      const revert = decodeRevert(err);
      if (revert) return revert.name === "DuplicatePayment"; // another refusal there can't confirm it
      throw err;
    }
  }

  async isAllowed(vault: Address, recipient: Address): Promise<boolean> {
    const [allowed] = await this.publicClient.readContract({
      address: vault,
      abi: leashVaultAbi,
      functionName: "recipientInfo",
      args: [recipient],
    });
    return allowed;
  }

  async waitForOutcome(hash: Hex): Promise<AttackOutcome> {
    let receipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) return { status: "pending", block: null };
      throw err;
    }
    // Final means the finalized head has passed the receipt's block and that block is still the one it was mined in.
    const deadline = Date.now() + FINALITY_WAIT_MS;
    while (Date.now() < deadline) {
      const finalized = await this.publicClient.getBlock({ blockTag: "finalized" });
      if (finalized.number >= receipt.blockNumber) {
        const block = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
        if (block.hash !== receipt.blockHash) return { status: "pending", block: null };
        return { status: receipt.status === "success" ? "succeeded" : "reverted", block: receipt.blockNumber };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { status: "pending", block: receipt.blockNumber };
  }

  async replayRevert(vault: Address, step: PayStep, block: bigint): Promise<VaultRevert | null> {
    try {
      await this.publicClient.simulateContract({
        ...payCall(vault, step),
        account: this.requireWallet().account,
        blockNumber: block - 1n,
      });
      return null;
    } catch (err) {
      const revert = decodeRevert(err, await this.tokenNames());
      if (revert) return revert;
      throw err;
    }
  }

  private resetNonce(): void {
    const account = this.walletClient?.account;
    account?.nonceManager?.reset({ address: account.address, chainId: bscTestnet.id });
  }

  private async tokenNames(): Promise<TokenNames> {
    if (!this.factory) return {};
    try {
      const d = await this.deployment();
      return { [d.usdt.toLowerCase()]: "USDT", [d.usdc.toLowerCase()]: "USDC", [d.tbill.toLowerCase()]: "T-bill" };
    } catch {
      return {};
    }
  }

  private requireFactory(): Address {
    if (!this.factory) {
      throw new ConfigurationError("FACTORY_ADDRESS is not set in .env yet. Builder A shares it after deploying.");
    }
    return this.factory;
  }

  private requireWallet(): AgentWallet {
    if (!this.walletClient) {
      throw new ConfigurationError("AGENT_PRIVATE_KEY is not set in .env, so the agent can't send transactions.");
    }
    return this.walletClient;
  }
}

function payCall(vault: Address, step: PayStep) {
  return {
    address: vault,
    abi: leashVaultAbi,
    functionName: "pay",
    args: [step.recipient, step.token, step.amount, step.ref],
  } as const;
}
