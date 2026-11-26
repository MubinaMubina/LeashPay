import {
  BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, ExecutionRevertedError,
  InsufficientFundsError, TransactionNotFoundError, TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError,
  encodeFunctionData, hashTypedData, isAddressEqual, keccak256, padHex, parseAbi, verifyTypedData, zeroAddress, zeroHash,
  type Address, type Chain, type Hex, type PrivateKeyAccount, type PublicClient, type Transport, type TypedData, type WalletClient,
} from "viem";
import { bscTestnet } from "viem/chains";
import { leashVaultAbi, leashVaultFactoryAbi } from "../abi/generated";
import { ConfigurationError } from "../config";
import { DEMO_RULES, RULES_PARAMETER, SponsorError, type SponsorExecute, type SponsorTypedData } from "./authorization";
import { SponsorReverted, type SponsorChain } from "./service";

const domainAbi = parseAbi([
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);
// Like LeashOwnerAuthorization, compare the entire ABI word containing the ERC-1271 magic bytes4.
const signatureAbi = parseAbi(["function isValidSignature(bytes32 digest, bytes signature) view returns (bytes32)"]);
const validSignature = padHex("0x1626ba7e", { size: 32, dir: "right" });
const domainError = "The sponsored factory must expose the LeashPay version 2 signing domain on chain 97.";
const balanceError = "The sponsor wallet needs testnet BNB for this transaction.";
const contractRefused = (err: unknown) => err instanceof BaseError && err.walk(cause =>
  cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError || cause instanceof ExecutionRevertedError);
const addAbi = parseAbi([
  "function addRecipientFor(address recipient, uint256 monthlyCap, uint256 nonce, uint256 deadline, bytes signature)",
  "function recipientNonce(address recipient) view returns (uint256)",
]);
const activateAbi = [{
  type: "function", stateMutability: "nonpayable", name: "createVaultFor",
  inputs: [{ type: "address", name: "owner" }, RULES_PARAMETER, { type: "uint256", name: "deadline" }, { type: "bytes", name: "signature" }],
  outputs: [{ type: "address", name: "vault" }],
}] as const;

type AgentWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;

/** Uses the payment executor's existing wallet client and nonce manager. Every relay transaction has zero value. */
export class ViemSponsorChain implements SponsorChain {
  readonly relayer: Address;

  constructor(private readonly client: PublicClient, private readonly wallet: AgentWallet, readonly factory: Address) {
    this.relayer = wallet.account.address;
  }

  async checkedTime() {
    if (await this.client.getChainId() !== bscTestnet.id) throw new ConfigurationError("Sponsorship requires BSC testnet (chain 97).");
    const [block, config, domain] = await Promise.all([
      this.client.getBlock({ blockTag: "latest" }),
      this.client.readContract({ address: this.factory, abi: leashVaultFactoryAbi, functionName: "config" }),
      this.client.readContract({ address: this.factory, abi: domainAbi, functionName: "eip712Domain" }).catch((err: unknown) => {
        if (contractRefused(err)) throw new ConfigurationError(domainError);
        throw err;
      }),
    ]);
    const [fields, name, version, chainId, target, salt, extensions] = domain;
    if (fields !== "0x0f" || name !== "LeashPay" || version !== "2" || chainId !== 97n ||
        !isAddressEqual(target, this.factory) || salt !== zeroHash || extensions.length !== 0) {
      throw new ConfigurationError(domainError);
    }
    if (!isAddressEqual(config.defaultAgent, this.relayer)) {
      throw new ConfigurationError("The factory's default agent must match the configured sponsor wallet.");
    }
    return block.timestamp;
  }

  async vaultOf(owner: Address, blockNumber?: bigint) {
    const vault = await this.client.readContract({ address: this.factory, abi: leashVaultFactoryAbi, functionName: "vaultOf", args: [owner], blockNumber });
    return vault === zeroAddress ? null : vault;
  }

  async recipient(vault: Address, recipient: Address, blockNumber?: bigint) {
    const contract = { address: vault, abi: leashVaultAbi, blockNumber } as const;
    const [owner, agent, [allowed, monthlyCap], nonce] = await Promise.all([
      this.client.readContract({ ...contract, functionName: "owner" }),
      this.client.readContract({ ...contract, functionName: "agent" }),
      this.client.readContract({ ...contract, functionName: "recipientInfo", args: [recipient] }),
      this.client.readContract({ address: vault, abi: addAbi, functionName: "recipientNonce", args: [recipient], blockNumber }),
    ]);
    return { owner, agent, nonce, allowed, monthlyCap };
  }

  async verify(owner: Address, data: SponsorTypedData, signature: Hex) {
    const code = await this.client.getCode({ address: owner });
    if (!code || code === "0x") {
      if (signature.length !== 132 || !/1[bc]$/i.test(signature)) return false;
      try {
        return await verifyTypedData<TypedData, string>({ ...data, address: owner, signature });
      } catch {
        return false;
      }
    }
    try {
      const digest = hashTypedData<TypedData, string>(data);
      const result = await this.client.readContract({
        address: owner, account: data.domain.verifyingContract, abi: signatureAbi, functionName: "isValidSignature", args: [digest, signature],
      });
      return result === validSignature;
    } catch (err) {
      if (contractRefused(err)) return false;
      throw err;
    }
  }

  async quote(request: SponsorExecute, target: Address) {
    const data = request.action === "activate"
      ? encodeFunctionData({ abi: activateAbi, functionName: "createVaultFor", args: [request.owner, DEMO_RULES, request.deadline, request.signature] })
      : encodeFunctionData({ abi: addAbi, functionName: "addRecipientFor", args: [request.recipient, request.monthlyCap, request.nonce, request.deadline, request.signature] });
    const call = { account: this.relayer, to: target, data, value: 0n } as const;
    const [estimate, gasPrice, balance] = await Promise.all([
      this.client.estimateGas(call).catch((err: unknown) => {
        // The estimate executes the signed call before the agent takes a nonce.
        if (contractRefused(err)) throw new SponsorError(409, "The contract refused this approval. Review the current vault state.");
        if (err instanceof BaseError && err.walk(cause => cause instanceof InsufficientFundsError)) throw new SponsorError(503, balanceError);
        throw err;
      }),
      this.client.getGasPrice(),
      this.client.getBalance({ address: this.relayer }),
    ]);
    const gas = (estimate * 120n + 99n) / 100n;
    const gasLimit = request.action === "activate" ? 6_000_000n : 200_000n;
    if (gas > gasLimit || gasPrice > 1_000_000_000n) throw new SponsorError(503, "The network fee exceeds the testnet sponsor's limit. Try again later.");
    const maxCost = gas * gasPrice;
    if (balance < maxCost) throw new SponsorError(503, balanceError);
    const sign = async () => {
      const account = this.wallet.account;
      try {
        const tx = await this.wallet.prepareTransactionRequest({
          ...call, account, chain: bscTestnet, type: "legacy", gas, gasPrice, nonceManager: account.nonceManager,
        });
        return await this.wallet.signTransaction(tx);
      } catch (err) {
        this.discardNonce();
        throw err;
      }
    };
    return { maxCost, sign };
  }

  discardNonce() {
    this.wallet.account.nonceManager?.reset({ address: this.relayer, chainId: bscTestnet.id });
  }

  async submit(raw: Hex) {
    const hash = keccak256(raw);
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash });
    } catch (err) {
      if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
      try {
        const sent = await this.wallet.sendRawTransaction({ serializedTransaction: raw });
        if (sent !== hash) throw new SponsorError(502, "The network returned an unexpected transaction hash. Retry to check the signed transaction.");
      } catch (sendError) {
        if (sendError instanceof SponsorError) throw sendError;
        // A retry may reach another node after the transaction was accepted or mined.
        if (!(sendError instanceof BaseError && /already known|nonce too low/i.test(sendError.message))) {
          if (!(await this.known(hash))) throw new SponsorError(502, "The sponsor could not confirm broadcast. Retry to check the same transaction.");
        }
      }
      try {
        receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      } catch (waitError) {
        if (waitError instanceof WaitForTransactionReceiptTimeoutError) {
          await this.known(hash);
          throw new SponsorError(503, "The sponsored transaction is awaiting confirmation. Try again in a moment.");
        }
        throw waitError;
      }
    }
    if (receipt.transactionHash !== hash || receipt.status !== "success") throw new SponsorReverted();
    return { hash, block: receipt.blockNumber };
  }

  private async known(hash: Hex) {
    try {
      await this.client.getTransaction({ hash });
      return true;
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError)) throw err;
      this.discardNonce(); // a dropped transaction must not leave a gap in the shared wallet's nonce sequence
      return false;
    }
  }
}
