import { encodeAbiParameters, getAbiItem, keccak256, maxUint256, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { z } from "zod";
import { leashVaultFactoryAbi } from "../abi/generated";
import { AddressSchema } from "../validation";

// The browser independently checks these rules before opening the signing prompt.
const token = 10n ** 18n;
export const DEMO_RULES = {
  perPaymentCap: 500n * token, dailyCap: 20_000n * token, cooldown: 60n,
  maxSlippageBps: 200n, dailySwapCap: 1_000n * token, minTokenPrice: 98n * 10n ** 16n,
} as const;
const ACTIVATE_VAULT_TYPES = {
  ActivateVault: [
    { name: "owner", type: "address" }, { name: "rulesHash", type: "bytes32" }, { name: "deadline", type: "uint256" },
  ],
} as const;
const ADD_RECIPIENT_TYPES = {
  AddRecipient: [
    { name: "recipient", type: "address" }, { name: "monthlyCap", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
} as const;

const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).transform(BigInt).refine(value => value <= maxUint256);
// ERC-1271 wallets may pre-authorize a digest and accept an empty bytes signature.
const signature = z.string().max(16_386).regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform(value => value as Hex);
const activate = z.strictObject({ action: z.literal("activate"), owner: AddressSchema });
const addRecipient = z.strictObject({
  action: z.literal("addRecipient"), owner: AddressSchema, recipient: AddressSchema,
  // Same 1 billion token maximum as the recipient form (18 decimals).
  monthlyCap: uint.refine(value => value > 0n && value <= 10n ** 27n),
});

export const SponsorPrepareBody = z.discriminatedUnion("action", [activate, addRecipient]);
export const SponsorExecuteBody = z.discriminatedUnion("action", [
  activate.extend({ deadline: uint, signature }),
  addRecipient.extend({ deadline: uint, nonce: uint, signature }),
]);
export type SponsorAction = z.infer<typeof SponsorPrepareBody>;
export type SponsorExecute = z.infer<typeof SponsorExecuteBody>;

export const RULES_PARAMETER = getAbiItem({ abi: leashVaultFactoryAbi, name: "createVault" }).inputs[0];
const rulesHash = keccak256(encodeAbiParameters([RULES_PARAMETER], [DEMO_RULES]));

export function sponsorTypedData(action: SponsorAction, target: Address, deadline: bigint, nonce: bigint) {
  const domain = { name: "LeashPay", version: "2", chainId: bscTestnet.id, verifyingContract: target } as const;
  if (action.action === "activate") {
    return { domain, primaryType: "ActivateVault", types: ACTIVATE_VAULT_TYPES, message: { owner: action.owner, rulesHash, deadline } } as const;
  }
  return {
    domain, primaryType: "AddRecipient", types: ADD_RECIPIENT_TYPES,
    message: { recipient: action.recipient, monthlyCap: action.monthlyCap, nonce, deadline },
  } as const;
}
export type SponsorTypedData = ReturnType<typeof sponsorTypedData>;

export class SponsorError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 429 | 502 | 503, message: string) { super(message); }
}
