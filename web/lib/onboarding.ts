import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { leashVaultFactoryAbi } from "./abi.generated";
import { FACTORY_ADDRESS } from "./chain";
import { publicClient } from "./client";
import { DEMO_RULES } from "./demo";
import type { SponsoredActionRunner } from "./sponsorship";

export async function readOwnerVault(owner: Address): Promise<Address | null> {
  const vault = await publicClient.readContract({
    address: FACTORY_ADDRESS, abi: leashVaultFactoryAbi, functionName: "vaultOf", args: [owner],
  });
  return vault === zeroAddress ? null : vault;
}

/** Only called when the owner explicitly chooses to enable on-chain payments. */
export async function activatePaymentVault(owner: Address, sendAndWait: (to: Address, data: Hex) => Promise<Hex>, sponsor?: SponsoredActionRunner) {
  const existing = await readOwnerVault(owner);
  if (existing) return existing;
  let sponsoredVault: Address | undefined;
  if (sponsor) {
    sponsoredVault = await sponsor({ action: "activate" });
  } else {
    if (await publicClient.getBalance({ address: owner }) === 0n) {
      throw new Error("Your account is open. To enable payments later, your wallet needs a little testnet BNB (tBNB) for the network fee.");
    }
    const data = encodeFunctionData({ abi: leashVaultFactoryAbi, functionName: "createVault", args: [DEMO_RULES] });
    await sendAndWait(FACTORY_ADDRESS, data);
  }
  const vault = await readOwnerVault(owner);
  if (!vault || (sponsoredVault && vault.toLowerCase() !== sponsoredVault.toLowerCase())) {
    throw new Error("Vault creation was submitted. Check again in a moment to open your confirmed vault.");
  }
  return vault;
}
