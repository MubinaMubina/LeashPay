import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import { bscTestnet } from "viem/chains";

/** LeashPay runs on BSC testnet only (chain 97). */
export const chain = bscTestnet;

// Published chain 97 deployments. The web and agent are independently deployable.
export const LEGACY_FACTORY_97: Address = "0x80b66347374C6df4f157368497201aa63a371f60";
export const SPONSORED_FACTORY_97: Address = "0xec8339Aa64277e759475c6777D7832652a390b99";

/** New vaults are created only at the explicitly selected factory. */
export const FACTORY_ADDRESS: Address = getAddress(
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS || LEGACY_FACTORY_97,
);

export function vaultFactories(factory: Address): readonly Address[] {
  return isAddressEqual(factory, SPONSORED_FACTORY_97) ? [factory, LEGACY_FACTORY_97] : [factory];
}

export const VAULT_FACTORIES = vaultFactories(FACTORY_ADDRESS);

export function sponsoredSetupEnabled(factory: Address, setting: string | undefined): boolean {
  const sponsor = setting?.trim();
  if (!sponsor) return false;
  if (!isAddress(sponsor, { strict: false }) || sponsor.toLowerCase() !== factory.toLowerCase()) {
    throw new Error("NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS must be a valid address matching NEXT_PUBLIC_FACTORY_ADDRESS.");
  }
  return !isAddressEqual(factory, LEGACY_FACTORY_97);
}

export const SPONSORED_SETUP = sponsoredSetupEnabled(FACTORY_ADDRESS, process.env.NEXT_PUBLIC_SPONSORED_FACTORY_ADDRESS);

export const explorerTx = (hash: string) => `https://testnet.bscscan.com/tx/${hash}`;
export const explorerAddress = (address: string) => `https://testnet.bscscan.com/address/${address}`;

/** 0x1234…abcd, for showing addresses in tight spaces. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
