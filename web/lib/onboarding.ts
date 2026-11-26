import { encodeFunctionData, zeroAddress, type Address, type Hex } from "viem";
import { leashVaultFactoryAbi } from "./abi.generated";
import { FACTORY_ADDRESS } from "./chain";
import { publicClient } from "./client";
import { DEMO_RULES } from "./demo";

export async function readOwnerVault(owner: Address): Promise<Address | null> {
  const vault = await publicClient.readContract({
    address: FACTORY_ADDRESS, abi: leashVaultFactoryAbi, functionName: "vaultOf", args: [owner],
  });
  return vault === zeroAddress ? null : vault;
}

/** Only called when the owner explicitly chooses to enable on-chain payments. */
export async function activatePaymentVault(owner: Address, sendAndWait: (to: Address, data: Hex) => Promise<Hex>) {
  const existing = await readOwnerVault(owner);
  if (existing) return existing;
  if (await publicClient.getBalance({ address: owner }) === 0n) {
    throw new Error("Your account is open. To enable payments later, your wallet needs a little testnet BNB (tBNB) for the network fee.");
  }
  const data = encodeFunctionData({ abi: leashVaultFactoryAbi, functionName: "createVault", args: [DEMO_RULES] });
  await sendAndWait(FACTORY_ADDRESS, data);
  const vault = await readOwnerVault(owner);
  if (!vault) throw new Error("Vault creation was confirmed. Check again in a moment to open your vault.");
  return vault;
}
