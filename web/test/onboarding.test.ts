import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, zeroAddress, type Address } from "viem";
import { FACTORY_ADDRESS } from "@/lib/chain";
import { leashVaultFactoryAbi } from "@/lib/abi.generated";
import { activatePaymentVault, readOwnerVault } from "@/lib/onboarding";
import { DEMO_RULES } from "@/lib/demo";

const { readContract, getBalance } = vi.hoisted(() => ({ readContract: vi.fn(), getBalance: vi.fn() }));
vi.mock("@/lib/client", () => ({ publicClient: { readContract, getBalance } }));

const owner: Address = "0x1111111111111111111111111111111111111111";
const vault: Address = "0x2222222222222222222222222222222222222222";
const send = vi.fn();

beforeEach(() => vi.resetAllMocks());

describe("opening a LeashPay account", () => {
  it.each([[zeroAddress, null], [vault, vault]])("only looks up vaultOf on login", async (onChain, expected) => {
    readContract.mockResolvedValueOnce(onChain);
    expect(await readOwnerVault(owner)).toBe(expected);
    expect(readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: FACTORY_ADDRESS, functionName: "vaultOf", args: [owner],
    }));
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("reports an unavailable lookup so an existing account is never shown as empty", async () => {
    readContract.mockRejectedValueOnce(new Error("RPC offline"));
    await expect(readOwnerVault(owner)).rejects.toThrow("RPC offline");
  });
});

describe("optional payment activation", () => {
  it("activates through the sponsor with no owner balance lookup or transaction", async () => {
    readContract.mockResolvedValueOnce(zeroAddress).mockResolvedValueOnce(vault);
    getBalance.mockResolvedValue(0n);
    const sponsor = vi.fn().mockResolvedValue(vault);
    expect(await activatePaymentVault(owner, send, sponsor)).toBe(vault);
    expect(sponsor).toHaveBeenCalledExactlyOnceWith({ action: "activate" });
    expect(getBalance).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a sponsor failure visible without asking the owner to pay gas", async () => {
    readContract.mockResolvedValueOnce(zeroAddress);
    getBalance.mockResolvedValue(10n ** 18n);
    const sponsor = vi.fn().mockRejectedValue(new Error("Sponsor unavailable"));
    await expect(activatePaymentVault(owner, send, sponsor)).rejects.toThrow("Sponsor unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("skips the wallet prompt when the owner has zero gas", async () => {
    readContract.mockResolvedValueOnce(zeroAddress);
    getBalance.mockResolvedValueOnce(0n);
    await expect(activatePaymentVault(owner, send)).rejects.toThrow(/tBNB/);
    expect(send).not.toHaveBeenCalled();
  });

  it("reuses an existing vault regardless of its stablecoin balances", async () => {
    readContract.mockResolvedValueOnce(vault);
    expect(await activatePaymentVault(owner, send)).toBe(vault);
    expect(send).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("only signs createVault and returns the owner's confirmed vault", async () => {
    readContract.mockResolvedValueOnce(zeroAddress).mockResolvedValueOnce(vault);
    getBalance.mockResolvedValueOnce(10n ** 16n);
    expect(await activatePaymentVault(owner, send)).toBe(vault);
    expect(send).toHaveBeenCalledTimes(1);
    const [target, data] = send.mock.calls[0];
    expect(target).toBe(FACTORY_ADDRESS);
    expect(decodeFunctionData({ abi: leashVaultFactoryAbi, data })).toEqual({
      functionName: "createVault", args: [DEMO_RULES],
    });
  });

  it("never reports activation until the owner's vault is readable", async () => {
    readContract.mockResolvedValue(zeroAddress);
    getBalance.mockResolvedValueOnce(10n ** 16n);
    await expect(activatePaymentVault(owner, send)).rejects.toThrow(/vault/i);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
