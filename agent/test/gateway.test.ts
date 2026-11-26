import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  InvalidInputRpcError,
  RpcRequestError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createNonceManager,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  keccak256,
  pad,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { leashVaultAbi } from "../src/abi/generated";
import type { PayStep } from "../src/chain/gateway";
import { ViemVaultGateway, createChainClients, judgePayment } from "../src/chain/viem-gateway";
import { AGENT, LINH, MARCO, USDC, USDT, VAULT } from "./fakes";

const HASH = pad("0x1", { size: 32 }) as Hex;
const OTHER = pad("0xee", { size: 32 }) as Hex;
const step: PayStep = { recipient: LINH, token: USDT, amount: 300n * 10n ** 18n, ref: keccak256("0x01") };

/** A Paid event log, as the vault would emit it. */
function paidLog(overrides: Partial<PayStep> & { from?: Address } = {}) {
  const s = { ...step, ...overrides };
  return {
    address: overrides.from ?? VAULT,
    topics: encodeEventTopics({ abi: leashVaultAbi, eventName: "Paid", args: { recipient: s.recipient, token: s.token, ref: s.ref } }),
    data: encodeAbiParameters([{ type: "uint256" }], [s.amount]),
    blockHash: pad("0xb", { size: 32 }),
    blockNumber: 10n,
    logIndex: 0,
    transactionHash: HASH,
    transactionIndex: 0,
    removed: false,
  };
}

const BLOCK = pad("0xb", { size: 32 }) as Hex;
const receipt = (logs: unknown[], status: "success" | "reverted" = "success", hash: Hex = HASH, blockNumber = 10n) =>
  ({ status, transactionHash: hash, blockNumber, blockHash: BLOCK, logs }) as never;

/** getBlock for a chain finalized at `finalized`, whose block at every height has hash `hash`. */
const chainAt = (finalized: bigint, hash: Hex = BLOCK) =>
  vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) =>
    args.blockTag === "finalized" ? { number: finalized, hash } : { number: args.blockNumber, hash },
  );

const notFound = (hash: Hex) => async () => {
  throw new TransactionReceiptNotFoundError({ hash });
};
const unknownTx = (hash: Hex) => async () => {
  throw new TransactionNotFoundError({ hash });
};

function wallet() {
  const reset = vi.fn();
  return {
    reset,
    client: {
      account: { address: AGENT, nonceManager: { reset } },
      prepareTransactionRequest: vi.fn(async (request: unknown) => request),
      signTransaction: vi.fn(async () => "0x02f8" as Hex),
      sendRawTransaction: vi.fn(async () => HASH),
    },
  };
}

describe("judgePayment", () => {
  it("counts a payment only when the vault's Paid event matches it exactly", () => {
    expect(judgePayment(VAULT, step, receipt([paidLog()]))).toEqual({ status: "paid", hash: HASH });
  });

  it("doesn't count a receipt without a matching Paid event (a replacement, another plan, another coin)", () => {
    const others = [
      [],
      [paidLog({ amount: 1n })],
      [paidLog({ recipient: MARCO })],
      [paidLog({ from: MARCO })],
      [paidLog({ ref: keccak256("0x02") })],
      [paidLog({ token: USDC })],
    ];
    for (const logs of others) expect(judgePayment(VAULT, step, receipt(logs)).status).toBe("not_paid");
  });

  it("doesn't count a reverted transaction", () => {
    expect(judgePayment(VAULT, step, receipt([paidLog()], "reverted"))).toMatchObject({ status: "not_paid" });
  });
});

describe("ViemVaultGateway.checkPayment", () => {
  const gateway = (client: Record<string, unknown>, w = wallet()) => new ViemVaultGateway(client as never, w.client as never, null);

  it("reads the finalized block before the receipt, and reports paid only within it", async () => {
    const calls: string[] = [];
    const finalizedAt = { height: 9n };
    const client = {
      getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => (
        calls.push(args.blockTag ?? "block"), { number: args.blockTag ? finalizedAt.height : args.blockNumber, hash: BLOCK }
      ),
      getTransactionReceipt: async () => (calls.push("receipt"), receipt([paidLog()])),
    };
    expect(await gateway(client).checkPayment(VAULT, step, HASH)).toEqual({ status: "pending" });
    expect(calls).toEqual(["finalized", "receipt"]);
    finalizedAt.height = 10n;
    expect(await gateway(client).checkPayment(VAULT, step, HASH)).toEqual({ status: "paid", hash: HASH });
  });

  it("doesn't count a receipt from a block the chain doesn't have at that height (a lost fork)", async () => {
    const client = { getBlock: chainAt(10n, pad("0xc", { size: 32 })), getTransactionReceipt: async () => receipt([paidLog()]) };
    expect(await gateway(client).checkPayment(VAULT, step, HASH)).toEqual({ status: "pending" });
  });

  it("reports pending while the transaction waits to be mined", async () => {
    const client = { getBlock: chainAt(9n), getTransactionReceipt: notFound(HASH), getTransaction: async () => ({ hash: HASH }) };
    expect(await gateway(client).checkPayment(VAULT, step, HASH)).toEqual({ status: "pending" });
  });

  it("frees the nonce of a transaction the chain doesn't know, so the resend doesn't leave a gap", async () => {
    const w = wallet();
    const client = { getBlock: chainAt(9n), getTransactionReceipt: notFound(HASH), getTransaction: unknownTx(HASH) };
    expect(await gateway(client, w).checkPayment(VAULT, step, HASH)).toEqual({ status: "unknown" });
    expect(w.reset).toHaveBeenCalledWith({ address: AGENT, chainId: 97 });
  });

  it("passes other RPC errors on instead of guessing", async () => {
    const client = {
      getBlock: chainAt(9n),
      getTransactionReceipt: async () => {
        throw new Error("RPC down");
      },
    };
    await expect(gateway(client).checkPayment(VAULT, step, HASH)).rejects.toThrow("RPC down");
  });

  it("relies on viem's nonce manager handing a freed nonce out again (pinned, since viem floats)", async () => {
    const manager = createNonceManager({ source: { get: () => 5, set: () => {} } });
    const at = { address: AGENT, chainId: 97, client: {} as never };
    expect(await manager.consume(at)).toBe(5);
    manager.reset(at);
    expect(await manager.consume(at)).toBe(5); // without the reset it would be 6, leaving a gap
  });
});

describe("ViemVaultGateway.waitForPayment", () => {
  it("is pending, not failed, when the wait times out", async () => {
    const client = {
      waitForTransactionReceipt: async () => {
        throw new WaitForTransactionReceiptTimeoutError({ hash: HASH });
      },
    };
    expect(await new ViemVaultGateway(client as never, null, null).waitForPayment(VAULT, step, HASH)).toEqual({ status: "pending" });
  });

  it("asks the chain again once the block is final, so a receipt a reorg dropped never counts", async () => {
    const client = {
      waitForTransactionReceipt: async () => receipt([paidLog()]), // seen once, at the head
      getBlock: chainAt(10n),
      getTransactionReceipt: notFound(HASH), // gone from the final chain
      getTransaction: unknownTx(HASH),
    };
    const gw = new ViemVaultGateway(client as never, wallet().client as never, null);
    expect(await gw.waitForPayment(VAULT, step, HASH)).toEqual({ status: "unknown" });
  });

  it("keeps asking until the block is final, then counts the payment", async () => {
    const getBlock = vi
      .fn()
      .mockImplementationOnce(async () => ({ number: 9n, hash: BLOCK })) // not final yet
      .mockImplementation(chainAt(10n));
    const client = { waitForTransactionReceipt: async () => receipt([paidLog()]), getBlock, getTransactionReceipt: async () => receipt([paidLog()]) };
    expect(await new ViemVaultGateway(client as never, null, null).waitForPayment(VAULT, step, HASH)).toEqual({ status: "paid", hash: HASH });
  });

  it("records a replacement that didn't pay under this payment's own hash", async () => {
    const replacement = receipt([], "success", OTHER);
    const client = {
      waitForTransactionReceipt: async () => replacement,
      getBlock: chainAt(10n),
      getTransactionReceipt: async () => replacement,
    };
    expect(await new ViemVaultGateway(client as never, null, null).waitForPayment(VAULT, step, HASH)).toMatchObject({
      status: "not_paid",
      hash: HASH,
      replacedBy: OTHER,
    });
  });
});

describe("ViemVaultGateway.signPay", () => {
  const revertWith = (errorName: "VaultPaused" | "DuplicatePayment", args: readonly unknown[] = []) =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: leashVaultAbi,
        data: encodeErrorResult({ abi: leashVaultAbi, errorName, args: args as never }),
        functionName: "pay",
      }),
      { abi: leashVaultAbi, functionName: "pay", args: [] },
    );
  const ready = { simulateContract: async () => ({}), estimateContractGas: async () => 100_000n };

  it("signs before sending, so the hash is known before the broadcast", async () => {
    const w = wallet();
    const gw = new ViemVaultGateway(ready as never, w.client as never, null);

    const signed = await gw.signPay(VAULT, step);

    expect(signed.hash).toBe(keccak256("0x02f8"));
    expect(w.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(w.client.prepareTransactionRequest).toHaveBeenCalledWith(expect.objectContaining({ to: VAULT, gas: 120_000n }));
    await signed.broadcast();
    expect(w.client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: "0x02f8" });
  });

  it("decodes a refusal the vault gives at estimate time instead of calling it a failure", async () => {
    const client = {
      simulateContract: async () => ({}),
      estimateContractGas: async () => {
        throw revertWith("VaultPaused");
      },
    };
    const gw = new ViemVaultGateway(client as never, wallet().client as never, null);
    await expect(gw.signPay(VAULT, step)).rejects.toMatchObject({ revert: { name: "VaultPaused" } });
  });

  it("frees the nonce when preparing or signing fails", async () => {
    const w = wallet();
    w.client.prepareTransactionRequest.mockRejectedValue(new Error("fee lookup failed"));
    await expect(new ViemVaultGateway(ready as never, w.client as never, null).signPay(VAULT, step)).rejects.toThrow("fee lookup failed");
    expect(w.reset).toHaveBeenCalled();
  });

  it("treats a node that already has the transaction as a successful broadcast, keeping its nonce", async () => {
    const w = wallet();
    w.client.sendRawTransaction.mockRejectedValue(
      new InvalidInputRpcError(new RpcRequestError({ body: {}, url: "http://rpc", error: { code: -32000, message: "already known" } })),
    );
    const signed = await new ViemVaultGateway(ready as never, w.client as never, null).signPay(VAULT, step);

    await expect(signed.broadcast()).resolves.toBeUndefined();
    expect(w.reset).not.toHaveBeenCalled();
  });

  it("frees the nonce when a broadcast fails, or when the payment is discarded", async () => {
    const w = wallet();
    w.client.sendRawTransaction.mockRejectedValue(new Error("connection reset"));
    const gw = new ViemVaultGateway(ready as never, w.client as never, null);

    await expect((await gw.signPay(VAULT, step)).broadcast()).rejects.toThrow("connection reset");
    expect(w.reset).toHaveBeenCalledTimes(1);
    (await gw.signPay(VAULT, step)).discard();
    expect(w.reset).toHaveBeenCalledTimes(2);
  });
});

describe("ViemVaultGateway.paidAsOfFinality", () => {
  const gw = (simulateContract: () => Promise<unknown>) =>
    new ViemVaultGateway({ simulateContract, getBlock: chainAt(77n) } as never, wallet().client as never, null);
  const refusing = (errorName: "DuplicatePayment" | "VaultPaused", args: readonly unknown[]) => async () => {
    throw new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: leashVaultAbi,
        data: encodeErrorResult({ abi: leashVaultAbi, errorName, args: args as never }),
        functionName: "pay",
      }),
      { abi: leashVaultAbi, functionName: "pay", args: [] },
    );
  };

  it("asks the vault at the finalized block's number (the public node refuses the 'finalized' tag for state)", async () => {
    const simulateContract = vi.fn(refusing("DuplicatePayment", [step.ref, LINH]));
    expect(await gw(simulateContract).paidAsOfFinality(VAULT, step)).toBe(true);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 77n }));
    expect(simulateContract).not.toHaveBeenCalledWith(expect.objectContaining({ blockTag: "finalized" }));
  });

  it("is false when the finalized state would still accept the payment, or refuses it for another reason", async () => {
    expect(await gw(async () => ({})).paidAsOfFinality(VAULT, step)).toBe(false);
    expect(await gw(refusing("VaultPaused", [])).paidAsOfFinality(VAULT, step)).toBe(false);
  });
});

describe("ViemVaultGateway.deployment", () => {
  it("asks again after a failure instead of caching it", async () => {
    const readContract = vi.fn().mockRejectedValueOnce(new Error("RPC down")).mockResolvedValueOnce({ usdt: USDT });
    const gw = new ViemVaultGateway({ readContract } as never, null, VAULT);
    await expect(gw.deployment()).rejects.toThrow("RPC down");
    await expect(gw.deployment()).resolves.toEqual({ usdt: USDT });
  });
});

describe("createChainClients", () => {
  it("polls for receipts at BSC speed, not viem's default of every 4 s", () => {
    const { publicClient } = createChainClients({ BSC_TESTNET_RPC_URL: "http://127.0.0.1:1", AGENT_PRIVATE_KEY: undefined });
    expect(publicClient.pollingInterval).toBe(500);
  });
});

describe("ViemVaultGateway demo attack", () => {
  const recipientNotAllowed = () =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: leashVaultAbi,
        data: encodeErrorResult({ abi: leashVaultAbi, errorName: "RecipientNotAllowed", args: [LINH] }),
        functionName: "pay",
      }),
      { abi: leashVaultAbi, functionName: "pay", args: [] },
    );

  it("signs with the fixed gas and no simulation, through the same nonce manager as real payments", async () => {
    const w = wallet();
    const client = { simulateContract: vi.fn(), estimateContractGas: vi.fn() };
    const gw = new ViemVaultGateway(client as never, w.client as never, null);

    const signed = await gw.signPayUnchecked(VAULT, step, 200_000n);

    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(client.estimateContractGas).not.toHaveBeenCalled();
    expect(w.client.prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ to: VAULT, gas: 200_000n, nonceManager: w.client.account.nonceManager }),
    );
    w.client.sendRawTransaction.mockRejectedValue(new Error("nonce too low"));
    await expect(signed.broadcast()).rejects.toThrow("nonce too low");
    expect(w.reset).toHaveBeenCalled();
  });

  it("replays pay() at the block before the receipt's and decodes the vault's refusal", async () => {
    const simulateContract = vi.fn(async () => {
      throw recipientNotAllowed();
    });
    const gw = new ViemVaultGateway({ simulateContract } as never, wallet().client as never, null);

    expect(await gw.replayRevert(VAULT, step, 500n)).toMatchObject({ name: "RecipientNotAllowed" });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 499n, functionName: "pay" }));
  });

  it("reports a reverted transaction only once its block is final", async () => {
    const blockHash = pad("0xb", { size: 32 }) as Hex;
    const getBlock = vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) =>
      args.blockTag === "finalized" ? { number: 12n } : { hash: blockHash, number: args.blockNumber },
    );
    const client = {
      waitForTransactionReceipt: async () => ({ status: "reverted", blockNumber: 10n, blockHash }),
      getBlock,
    };
    expect(await new ViemVaultGateway(client as never, null, null).waitForOutcome(HASH)).toEqual({ status: "reverted", block: 10n });
  });

  it("answers pending when no receipt arrives in time", async () => {
    const client = {
      waitForTransactionReceipt: async () => {
        throw new WaitForTransactionReceiptTimeoutError({ hash: HASH });
      },
    };
    expect(await new ViemVaultGateway(client as never, null, null).waitForOutcome(HASH)).toEqual({ status: "pending", block: null });
  });
});
