import path from "node:path";
import {
  ContractFunctionZeroDataError, decodeFunctionData, keccak256, padHex, parseAbi, parseGwei,
  type Address, type Hex, type TypedData, zeroAddress, zeroHash,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { DEMO_RULES, SponsorExecuteBody, sponsorTypedData } from "../src/sponsor/authorization";
import { ViemSponsorChain } from "../src/sponsor/chain";
import { SponsorshipService } from "../src/sponsor/service";
import { AGENT, LINH, OWNER, OWNER_ACCOUNT, VAULT, tempDir } from "./fakes";

const factory = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const signature = "0x1234" as Hex;
const activation = SponsorExecuteBody.parse({ owner: OWNER, action: "activate", deadline: "1800000600", signature });
const addition = SponsorExecuteBody.parse({ owner: OWNER, action: "addRecipient", recipient: LINH, monthlyCap: "125", nonce: "10", deadline: "1800000600", signature });
const functions = parseAbi([
  "struct Rules { uint256 perPaymentCap; uint256 dailyCap; uint256 cooldown; uint256 maxSlippageBps; uint256 dailySwapCap; uint256 minTokenPrice; }",
  "function createVaultFor(address owner, Rules rules, uint256 deadline, bytes signature) returns (address)",
  "function addRecipientFor(address recipient, uint256 monthlyCap, uint256 nonce, uint256 deadline, bytes signature)",
]);

function setup() {
  const domain: readonly unknown[] = ["0x0f", "LeashPay", "2", 97n, factory, zeroHash, []];
  const client = {
    getChainId: vi.fn(async () => 97),
    getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === "eip712Domain" ? domain : { defaultAgent: AGENT }),
    estimateGas: vi.fn(async (_request: { data: Hex }) => 100_001n),
    getGasPrice: vi.fn(async () => parseGwei("0.1")),
    getBalance: vi.fn(async () => 10n ** 18n),
  };
  const wallet = {
    account: { address: AGENT, nonceManager: { reset: vi.fn() } },
    prepareTransactionRequest: vi.fn(async (request: unknown) => request),
    signTransaction: vi.fn(async () => "0xcafe" as Hex), sendRawTransaction: vi.fn(),
  };
  return { client, wallet, chain: new ViemSponsorChain(client as never, wallet as never, factory) };
}

describe("V2 testnet relayer", () => {
  it("refuses activation and recipient changes for a V1-only owner before issuing or relaying an approval", async () => {
    const { client, wallet } = setup();
    const legacyFactory = "0x1111111111111111111111111111111111111112";
    const readContract = async (request: { address: Address; functionName: string }) => {
      if (request.functionName === "vaultOf") return request.address === legacyFactory ? VAULT : zeroAddress;
      return client.readContract(request);
    };
    const chain = new ViemSponsorChain({ ...client, readContract } as never, wallet as never, factory, legacyFactory);
    const service = new SponsorshipService(chain, path.join(tempDir(), "sponsorships.json"));
    for (const request of [activation, addition]) {
      await expect(service.prepare(request)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("V1") });
      await expect(service.execute(request)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("V1") });
    }
    expect(wallet.prepareTransactionRequest).not.toHaveBeenCalled();
  });

  it("checks the provider chain, deployed domain, configured factory address and agent", async () => {
    const { chain, client } = setup();
    expect(await chain.checkedTime()).toBe(1_800_000_000n);
    client.getChainId.mockResolvedValueOnce(56);
    await expect(chain.checkedTime()).rejects.toThrow(/chain 97/);
    for (const value of [
      ["0x0f", "Other", "2", 97n, factory, zeroHash, []],
      ["0x0f", "LeashPay", "1", 97n, factory, zeroHash, []],
      ["0x0f", "LeashPay", "2", 97n, zeroAddress, zeroHash, []],
    ]) {
      client.readContract.mockImplementationOnce(async () => ({ defaultAgent: AGENT })).mockResolvedValueOnce(value);
      await expect(chain.checkedTime()).rejects.toThrow(/version 2/);
    }
    client.readContract.mockImplementationOnce(async () => ({ defaultAgent: OWNER }));
    await expect(chain.checkedTime()).rejects.toThrow(/default agent/);
    client.readContract.mockImplementationOnce(async () => ({ defaultAgent: AGENT })).mockRejectedValueOnce(new ContractFunctionZeroDataError({ functionName: "eip712Domain" }));
    await expect(chain.checkedTime()).rejects.toThrow(/version 2/);
  });

  it("simulates and signs only the exact zero-value call, with the shared nonce manager and capped gas", async () => {
    const { chain, client, wallet } = setup();
    for (const [request, target] of [[activation, factory], [addition, VAULT]] as const) {
      const quote = await chain.quote(request, target);
      expect(quote.maxCost).toBe(120_002n * parseGwei("0.1"));
      expect(await quote.sign()).toBe("0xcafe");
      const call = client.estimateGas.mock.lastCall![0];
      expect(call).toMatchObject({ account: AGENT, value: 0n, to: target });
      expect(decodeFunctionData({ abi: functions, data: call.data })).toEqual(request.action === "activate"
        ? { functionName: "createVaultFor", args: [OWNER, DEMO_RULES, 1_800_000_600n, signature] }
        : { functionName: "addRecipientFor", args: [LINH, 125n, 10n, 1_800_000_600n, signature] });
      expect(wallet.prepareTransactionRequest.mock.lastCall![0]).toMatchObject({
        account: wallet.account, chain: { id: 97 }, to: target, value: 0n, data: call.data,
        type: "legacy", gas: 120_002n, gasPrice: parseGwei("0.1"), nonceManager: wallet.account.nonceManager,
      });
    }
    expect(wallet.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("checks EOAs by recovery and contract-wallet signatures against ERC-1271 from the verifying contract", async () => {
    const client = { getCode: vi.fn(async () => "0x"), readContract: vi.fn(async () => padHex("0x1626ba7e", { size: 32, dir: "right" })) };
    const { wallet } = setup();
    const chain = new ViemSponsorChain(client as never, wallet as never, factory);
    const data = sponsorTypedData(activation, factory, activation.deadline, 0n);
    const signed = await OWNER_ACCOUNT.signTypedData<TypedData, string>(data);
    expect(await chain.verify(OWNER, data, signed)).toBe(true);
    expect(await chain.verify(OWNER, data, "0x")).toBe(false);
    expect(client.readContract).not.toHaveBeenCalled();
    client.getCode.mockResolvedValue("0x1234");
    expect(await chain.verify(OWNER, data, "0x")).toBe(true);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: OWNER, account: factory, functionName: "isValidSignature" }));
    client.readContract.mockResolvedValueOnce(zeroHash);
    expect(await chain.verify(OWNER, data, signed)).toBe(false);
  });

  it("stops before taking a nonce when the gas price, per-call gas limit or sponsor balance is insufficient", async () => {
    const { chain, client, wallet } = setup();
    client.getGasPrice.mockResolvedValueOnce(parseGwei("1.01"));
    await expect(chain.quote(activation, factory)).rejects.toThrow(/limit/);
    client.estimateGas.mockResolvedValueOnce(5_000_001n);
    await expect(chain.quote(activation, factory)).rejects.toThrow(/limit/);
    client.estimateGas.mockResolvedValueOnce(175_000n);
    await expect(chain.quote(addition, VAULT)).rejects.toThrow(/limit/);
    client.getBalance.mockResolvedValueOnce(1n);
    await expect(chain.quote(activation, factory)).rejects.toThrow(/sponsor wallet/i);
    expect(wallet.prepareTransactionRequest).not.toHaveBeenCalled();
  });

  it("requires a successful receipt of the signed transaction before reporting its block", async () => {
    const raw = "0x55" as Hex;
    const hash = keccak256(raw);
    const getTransactionReceipt = vi.fn(async () => ({ transactionHash: hash, status: "success", blockNumber: 3n }));
    const { wallet } = setup();
    const chain = new ViemSponsorChain({ getTransactionReceipt } as never, wallet as never, factory);
    expect(await chain.submit(raw)).toEqual({ hash, block: 3n });
    getTransactionReceipt.mockResolvedValueOnce({ transactionHash: hash, status: "reverted", blockNumber: 3n });
    await expect(chain.submit(raw)).rejects.toThrow(/revert/);
    getTransactionReceipt.mockResolvedValueOnce({ transactionHash: zeroHash, status: "success", blockNumber: 3n });
    await expect(chain.submit(raw)).rejects.toThrow();
    expect(wallet.sendRawTransaction).not.toHaveBeenCalled();
  });
});
