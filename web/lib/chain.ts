import { getAddress, type Address } from "viem";
import { bscTestnet } from "viem/chains";

/** LeashPay runs on BSC testnet only (chain 97). */
export const chain = bscTestnet;

/**
 * The factory every owner's vault comes from. Set NEXT_PUBLIC_FACTORY_ADDRESS in the
 * root .env; the value below is the chain 97 deployment in contracts/deployments/97.json.
 */
export const FACTORY_ADDRESS: Address = getAddress(
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS || "0x80b66347374C6df4f157368497201aa63a371f60",
);

export const explorerTx = (hash: string) => `https://testnet.bscscan.com/tx/${hash}`;
export const explorerAddress = (address: string) => `https://testnet.bscscan.com/address/${address}`;

/** 0x1234…abcd, for showing addresses in tight spaces. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
