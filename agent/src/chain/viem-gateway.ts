import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  nonceManager,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { leashVaultAbi, leashVaultFactoryAbi } from "../abi/generated";
import { ConfigurationError, type Config } from "../config";
import { VaultRevertError, decodeRevert, type TokenNames, type VaultRevert } from "./errors";
import type { DeploymentConfig, PayStep, ReceiptStatus, VaultGateway, VaultSnapshot } from "./gateway";

type AgentWallet = WalletClient<Transport, Chain, Account>;

/** BSC testnet clients. The wallet exists only when AGENT_PRIVATE_KEY is set. */
export function createChainClients(config: Pick<Config, "BSC_TESTNET_RPC_URL" | "AGENT_PRIVATE_KEY">) {
  const transport = http(config.BSC_TESTNET_RPC_URL);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
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

  async previewPay(vault: Address, step: PayStep): Promise<VaultRevert | null> {
    const account =
      this.walletClient?.account ??
      (await this.publicClient.readContract({ address: vault, abi: leashVaultAbi, functionName: "agent" }));
    try {
      await this.publicClient.simulateContract({
        address: vault,
        abi: leashVaultAbi,
        functionName: "pay",
        args: [step.recipient, step.token, step.amount, step.ref],
        account,
      });
      return null;
    } catch (err) {
      const revert = decodeRevert(err, await this.tokenNames());
      if (revert) return revert;
      throw err;
    }
  }

  async sendPay(vault: Address, step: PayStep): Promise<Hex> {
    const wallet = this.requireWallet();
    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({
        address: vault,
        abi: leashVaultAbi,
        functionName: "pay",
        args: [step.recipient, step.token, step.amount, step.ref],
        account: wallet.account,
      }));
    } catch (err) {
      const revert = decodeRevert(err, await this.tokenNames());
      if (revert) throw new VaultRevertError(revert);
      throw err;
    }
    return wallet.writeContract(request);
  }

  async waitForReceipt(hash: Hex): Promise<"success" | "reverted"> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return receipt.status;
  }

  async receiptStatus(hash: Hex): Promise<ReceiptStatus> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      return receipt.status;
    } catch (err) {
      if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
    }
    try {
      await this.publicClient.getTransaction({ hash });
      return "pending";
    } catch (err) {
      if (err instanceof TransactionNotFoundError) return "unknown";
      throw err;
    }
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
