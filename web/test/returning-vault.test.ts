import { decodeFunctionData, type Address, type Hex, zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leashVaultAbi } from "@/lib/abi.generated";
import { AddRecipientForm, RecipientAuthorizationContext } from "@/components/RecipientForm";
import { activateOwnerVault, activatePaymentVault, readOwnerVault } from "@/lib/onboarding";
import * as sponsorship from "@/lib/sponsorship";

const { readContract, getBalance } = vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_FACTORY_ADDRESS", "0xec8339Aa64277e759475c6777D7832652a390b99");
  vi.stubEnv("NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS", "0xec8339Aa64277e759475c6777D7832652a390b99");
  return { readContract: vi.fn(), getBalance: vi.fn() };
});
vi.mock("@/lib/client", () => ({
  publicClient: { readContract, getBalance },
  useOwnerWallet: () => ({ address: owner }), useApi: () => vi.fn(),
  useSendAndWait: () => vi.fn(), useSponsoredAction: () => vi.fn(),
}));

const legacyFactory: Address = "0x80b66347374C6df4f157368497201aa63a371f60";
const sponsoredFactory: Address = "0xec8339Aa64277e759475c6777D7832652a390b99";
const owner: Address = "0x1111111111111111111111111111111111111111";
const oldVault: Address = "0x2222222222222222222222222222222222222222";
const newVault: Address = "0x3333333333333333333333333333333333333333";
const recipient: Address = "0x4444444444444444444444444444444444444444";

function registry(v2: Address | Error, v1: Address | Error) {
  readContract.mockImplementation(({ address, functionName, args }) => {
    const value = address === sponsoredFactory ? v2 : address === legacyFactory ? v1 : new Error("Unexpected factory");
    if (value instanceof Error) throw value;
    if (functionName !== "vaultOf" || args[0] !== owner) throw new Error("Unexpected lookup");
    return Promise.resolve(value);
  });
}

beforeEach(() => vi.resetAllMocks());

describe("returning owners on the published sponsored deployment", () => {
  it("opens the existing V1 vault when V2 reports zero, including on an explicit activation retry", async () => {
    registry(zeroAddress, oldVault);
    expect(await readOwnerVault(owner)).toBe(oldVault);
    expect(readContract.mock.calls.map(([call]) => call.address)).toEqual([sponsoredFactory, legacyFactory]);
    const send = vi.fn();
    const relay = vi.fn();
    expect(await activatePaymentVault(owner, send, relay)).toBe(oldVault);
    expect(send).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it.each([zeroAddress, oldVault])("opens the explicit V2 vault without querying V1 (%s)", async legacyVault => {
    registry(newVault, legacyVault);
    expect(await readOwnerVault(owner)).toBe(newVault);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new Error("V2 RPC unavailable"), oldVault, 1],
    [zeroAddress, new Error("V1 RPC unavailable"), 2],
  ] as const)("leaves activation unavailable when a required factory read fails", async (v2, v1, calls) => {
    registry(v2, v1);
    const relay = vi.fn();
    const send = vi.fn();
    await expect(activatePaymentVault(owner, send, relay)).rejects.toThrow("RPC unavailable");
    expect(readContract).toHaveBeenCalledTimes(calls);
    expect(relay).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("requires a decoded zero address before looking beyond the configured factory", async () => {
    readContract.mockResolvedValueOnce(undefined).mockResolvedValueOnce(oldVault);
    await expect(readOwnerVault(owner)).rejects.toThrow(/vault address/i);
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("activates a new user at V2 only after both registries report zero", async () => {
    registry(zeroAddress, zeroAddress);
    const relay = vi.fn(async () => {
      expect(readContract.mock.calls.map(([call]) => call.address)).toEqual([sponsoredFactory, legacyFactory]);
      registry(newVault, zeroAddress);
      return newVault;
    });
    expect(await activateOwnerVault(owner, vi.fn(), relay)).toEqual({ address: newVault, factory: sponsoredFactory });
    expect(readContract.mock.calls.map(([call]) => call.address)).toEqual([sponsoredFactory, legacyFactory, sponsoredFactory]);
    expect(relay).toHaveBeenCalledExactlyOnceWith({ action: "activate" });
  });
});

describe("adding a recipient to the owner's actual vault", () => {
  it.each([
    [oldVault, legacyFactory, /your wallet pays.*network fee in tBNB/i],
    [newVault, sponsoredFactory, /LeashPay covers the network fee/i],
  ] as const)("shows who pays the network fee before the recipient is reviewed", (vault, factory, gasCopy) => {
    const authorization = sponsorship.recipientAuthorizationFor({ address: vault, factory }, vi.fn(), vi.fn());
    const html = renderToStaticMarkup(createElement(RecipientAuthorizationContext, { value: authorization },
      createElement(AddRecipientForm, { vault, agent: null, book: { list: [], error: null, readDirectory: vi.fn(), revision: 0,
        changed: vi.fn(), refresh: vi.fn() }, onAdded: vi.fn(), onCancel: vi.fn() })));
    expect(html).toMatch(gasCopy);
  });

  it("requires a direct owner transaction for the old vault even when a sponsor is available", async () => {
    const send = vi.fn(async (_to: Address, _data: Hex, _options?: { ownerPaidDescription?: string }) => "0x12" as Hex);
    const relay = vi.fn();
    const authorization = sponsorship.recipientAuthorizationFor({ address: oldVault, factory: legacyFactory }, send, relay);
    expect(authorization.sponsored).toBe(false);
    expect(authorization.includesPaymentFees).toBe(false);
    await authorization.authorize(recipient, 600n);
    expect(relay).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const [[to, data, options]] = send.mock.calls;
    expect(to).toBe(oldVault);
    expect(decodeFunctionData({ abi: leashVaultAbi, data })).toEqual({ functionName: "setRecipient", args: [recipient, true, 600n] });
    expect(options?.ownerPaidDescription).toMatch(/your wallet pays.*network fee in tBNB/i);
  });

  it("relays the reviewed recipient and cap only for the configured vault", async () => {
    const send = vi.fn();
    const relay = vi.fn().mockResolvedValue(newVault);
    const authorization = sponsorship.recipientAuthorizationFor({ address: newVault, factory: sponsoredFactory }, send, relay);
    expect(authorization.sponsored).toBe(true);
    expect(authorization.includesPaymentFees).toBe(true);
    await authorization.authorize(recipient, 600n);
    expect(relay).toHaveBeenCalledExactlyOnceWith({ action: "addRecipient", vault: newVault, recipient, monthlyCap: 600n });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the direct V2 path available when the operator disabled sponsorship", async () => {
    const send = vi.fn();
    const authorization = sponsorship.recipientAuthorizationFor({ address: newVault, factory: sponsoredFactory }, send);
    expect(authorization.sponsored).toBe(false);
    expect(authorization.includesPaymentFees).toBe(true);
    await authorization.authorize(recipient, 600n);
    expect(send).toHaveBeenCalledExactlyOnceWith(newVault, expect.any(String), expect.objectContaining({ ownerPaidDescription: expect.any(String) }));
  });
});
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
