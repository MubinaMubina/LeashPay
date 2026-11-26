import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, formatUnits, getAbiItem, hashTypedData, keccak256, type Address } from "viem";
import { leashVaultFactoryAbi } from "@/lib/abi.generated";
import { FACTORY_ADDRESS, sponsoredSetupEnabled, vaultFactories } from "@/lib/chain";
import { DEMO_RULES } from "@/lib/demo";
import { runSponsoredAction, type SponsorAction } from "@/lib/sponsorship";

const owner: Address = "0x1111111111111111111111111111111111111111";
const vault: Address = "0x2222222222222222222222222222222222222222";
const recipient: Address = "0x3333333333333333333333333333333333333333";
const cap = 12345678901234567890123n;
const rulesHash = keccak256(encodeAbiParameters(getAbiItem({ abi: leashVaultFactoryAbi, name: "createVault" }).inputs, [DEMO_RULES]));
const domain = { name: "LeashPay", version: "2", chainId: 97, verifyingContract: vault };
const fields = [{ name: "recipient", type: "address" }, { name: "monthlyCap", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }];
const add: SponsorAction = { action: "addRecipient", vault, recipient, monthlyCap: cap };

function prepare() {
  const deadline = String(Math.floor(Date.now() / 1000) + 300);
  const nonce = "12345678901234567890";
  const typedData = { domain, primaryType: "AddRecipient", types: { AddRecipient: fields },
    message: { recipient, monthlyCap: cap.toString(), nonce, deadline } };
  return { typedData, deadline, nonce };
}
const ok = (body: unknown) => ({ ok: true, status: 200, body });

describe("sponsored deployment selection", () => {
  it("keeps an empty setting on the legacy flow and enables a matching address", () => {
    expect(sponsoredSetupEnabled(FACTORY_ADDRESS, undefined)).toBe(false);
    expect(sponsoredSetupEnabled(FACTORY_ADDRESS, "   ")).toBe(false);
    expect(sponsoredSetupEnabled(vault, vault.toLowerCase())).toBe(true);
  });

  it("looks up only the configured factory on custom and original deployments", () => {
    expect(vaultFactories(vault)).toEqual([vault]);
    const legacy = "0x80b66347374C6df4f157368497201aa63a371f60";
    expect(vaultFactories(legacy)).toEqual([legacy]);
    expect(sponsoredSetupEnabled(legacy, legacy)).toBe(false);
  });

  it.each(["wrong", recipient])("stops on an explicitly invalid or mismatched sponsor setting", (configured) => {
    expect(() => sponsoredSetupEnabled(FACTORY_ADDRESS, configured)).toThrow(/NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS/);
  });
});

describe("owner-signed, relayed actions", () => {
  it("signs the reviewed add for the embedded owner and relays its exact decimal cap, nonce and deadline", async () => {
    const prepared = prepare();
    const api = vi.fn().mockResolvedValueOnce(ok(prepared)).mockResolvedValueOnce(ok({ vault }));
    const sign = vi.fn().mockResolvedValue({ signature: "0x1234" });
    expect(await runSponsoredAction(owner, add, api, sign)).toBe(vault);
    const body = { action: "addRecipient", owner, recipient, monthlyCap: cap.toString() };
    expect(api.mock.calls).toEqual([["sponsor/prepare", { body }],
      ["sponsor/execute", { body: { ...body, deadline: prepared.deadline, nonce: prepared.nonce, signature: "0x1234" } }]]);
    const [typedData, options] = sign.mock.calls[0];
    expect(typedData.types.EIP712Domain).toContainEqual({ name: "verifyingContract", type: "address" });
    expect(hashTypedData(typedData)).toBe(hashTypedData(prepared.typedData));
    expect(options).toMatchObject({ address: owner, uiOptions: { showWalletUIs: true } });
    expect(options.uiOptions.description).toContain(formatUnits(cap, 18));
  });

  it("binds activation to this factory and the reviewed vault rules", async () => {
    const { deadline } = prepare();
    expect(rulesHash).toBe("0x52d129d398847c5caf7a9ec999de0156e764c966103b1c9bb5450455f5536070");
    const typedData = { domain: { ...domain, verifyingContract: FACTORY_ADDRESS }, primaryType: "ActivateVault",
      types: { ActivateVault: [{ name: "owner", type: "address" }, { name: "rulesHash", type: "bytes32" }, { name: "deadline", type: "uint256" }] },
      message: { owner, rulesHash, deadline } };
    const sign = vi.fn().mockResolvedValue({ signature: "0x1234" });
    const prepared = { typedData, deadline };
    const api = vi.fn().mockResolvedValueOnce(ok(prepared)).mockResolvedValueOnce(ok({ vault }));
    await expect(runSponsoredAction(owner, { action: "activate" }, api, sign)).resolves.toBe(vault);
    expect(hashTypedData(sign.mock.calls[0][0])).toBe(hashTypedData(typedData));
    expect(api.mock.calls[1][1].body).toEqual({ action: "activate", owner, deadline, signature: "0x1234" });
    const changed = { ...typedData, message: { owner, rulesHash: "0x" + "00".repeat(32), deadline } };
    const wrong = vi.fn().mockResolvedValue(ok({ ...prepared, typedData: changed }));
    await expect(runSponsoredAction(owner, { action: "activate" }, wrong, sign)).rejects.toThrow();
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it.each(["contract", "network", "address", "amount", "nonce", "deadline", "type", "fields", "expired", "extended lifetime"])(
    "rejects an add request with a different %s before opening the wallet", async change => {
      const prepared = structuredClone(prepare());
      const data = prepared.typedData;
      if (change === "contract") data.domain.verifyingContract = recipient;
      if (change === "network") data.domain.chainId = 56;
      if (change === "address") data.message.recipient = owner;
      if (change === "amount") data.message.monthlyCap = String(cap + 1n);
      if (change === "nonce") data.message.nonce = "0";
      if (change === "deadline") data.message.deadline = "1";
      if (change === "type") data.primaryType = "Transfer";
      if (change === "fields") data.types.AddRecipient.pop();
      if (change === "expired") data.message.deadline = prepared.deadline = "1";
      if (change === "extended lifetime") data.message.deadline = prepared.deadline = String(Math.floor(Date.now() / 1000) + 86_400);
      const api = vi.fn().mockResolvedValueOnce(ok(prepared));
      const sign = vi.fn();
      await expect(runSponsoredAction(owner, add, api, sign)).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
      expect(api).toHaveBeenCalledTimes(1);
    },
  );

  it("does not relay a cancelled signature", async () => {
    const api = vi.fn().mockResolvedValueOnce(ok(prepare()));
    const sign = vi.fn().mockRejectedValue(new Error("Cancelled"));
    await expect(runSponsoredAction(owner, add, api, sign)).rejects.toThrow("Cancelled");
    expect(api).toHaveBeenCalledTimes(1);
  });
});
