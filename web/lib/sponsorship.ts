import type { useSignTypedData } from "@privy-io/react-auth";
import {
  encodeAbiParameters, formatUnits, getAbiItem, getAddress, getTypesForEIP712Domain, isAddress,
  keccak256, maxUint256, zeroAddress, type Address, type TypedDataParameter,
} from "viem";
import { leashVaultFactoryAbi } from "./abi.generated";
import { chain, FACTORY_ADDRESS } from "./chain";
import type { useApi } from "./client";
import { DEMO_RULES } from "./demo";

export type SponsorAction = { action: "activate" } | { action: "addRecipient"; vault: Address; recipient: Address; monthlyCap: bigint };
export type SponsoredActionRunner = (action: SponsorAction) => Promise<Address>;
type Sign = ReturnType<typeof useSignTypedData>["signTypedData"];
type SigningData = Parameters<Sign>[0];
interface Preparation { typedData: SigningData; deadline: string; nonce?: string }

const rulesHash = keccak256(encodeAbiParameters(getAbiItem({ abi: leashVaultFactoryAbi, name: "createVault" }).inputs, [DEMO_RULES]));
const activateFields = [
  { name: "owner", type: "address" }, { name: "rulesHash", type: "bytes32" }, { name: "deadline", type: "uint256" },
];
const recipientFields = [
  { name: "recipient", type: "address" }, { name: "monthlyCap", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
];

function isUint(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) <= maxUint256;
}

function sameFields(actual: TypedDataParameter[] | undefined, expected: readonly TypedDataParameter[]) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((field, index) => actual[index]?.name === field.name && actual[index]?.type === field.type);
}

/** Sign only the locally reviewed action. The relayer supplies a fresh deadline and vault nonce. */
function reviewedData(owner: Address, action: SponsorAction, prepared: Preparation): SigningData {
  const { deadline, nonce = "", typedData } = prepared;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (!isUint(deadline) || BigInt(deadline) <= now) {
    throw new Error("This authorization has expired. Try again for a fresh signature.");
  }
  const mismatch = new Error("The signature request differs from the action you reviewed. Try again.");
  // The relayer issues ten-minute authorizations. Allow one minute between chain and device clocks.
  if (BigInt(deadline) > now + 660n) throw mismatch;
  const activate = action.action === "activate";
  if (!activate && !isUint(nonce)) throw mismatch;
  const domain = { name: "LeashPay", version: "2", chainId: chain.id, verifyingContract: activate ? FACTORY_ADDRESS : action.vault };
  const primaryType = activate ? "ActivateVault" : "AddRecipient";
  const fields = activate ? activateFields : recipientFields;
  const message: Record<string, string> = activate
    ? { owner, rulesHash, deadline }
    : { recipient: action.recipient, monthlyCap: String(action.monthlyCap), nonce, deadline };
  const domainFields = getTypesForEIP712Domain({ domain });
  const received = typedData?.domain;
  if (!received || received.name !== domain.name || received.version !== domain.version ||
      String(received.chainId) !== String(domain.chainId) || received.verifyingContract?.toLowerCase() !== domain.verifyingContract.toLowerCase() ||
      received.salt !== undefined || typedData.primaryType !== primaryType || !sameFields(typedData.types?.[primaryType], fields) ||
      (typedData.types.EIP712Domain !== undefined && !sameFields(typedData.types.EIP712Domain, domainFields)) ||
      !Object.entries(message).every(([key, value]) => {
        const actual = typedData.message?.[key];
        return typeof actual === "string" && actual.toLowerCase() === value.toLowerCase();
      })) throw mismatch;
  return { domain, primaryType, types: { EIP712Domain: domainFields, [primaryType]: [...fields] }, message };
}

export async function runSponsoredAction(owner: Address, action: SponsorAction, api: ReturnType<typeof useApi>, sign: Sign): Promise<Address> {
  const adding = action.action === "addRecipient";
  const body = adding
    ? { owner, action: action.action, recipient: action.recipient, monthlyCap: String(action.monthlyCap) }
    : { owner, action: action.action };
  const prepared = await api<Preparation>("sponsor/prepare", { body });
  if (!prepared.ok) throw new Error(prepared.body.error || "Couldn’t prepare the sponsored action. Try again.");
  const typedData = reviewedData(owner, action, prepared.body);
  const description = adding
    ? `Set a cap of ${formatUnits(action.monthlyCap, 18)} USDT or USDC per 30 days for payments to ${action.recipient}, including payment fees. LeashPay covers the network fee to add this recipient.`
    : "Allow LeashPay to activate your vault with its spending limits. LeashPay covers the network fee.";
  const { signature } = await sign(typedData, { address: owner, uiOptions: {
    showWalletUIs: true, title: adding ? "Add recipient" : "Activate vault", description,
  } });
  const executed = await api<{ vault: Address }>("sponsor/execute", { body: {
    ...body, signature, deadline: prepared.body.deadline, ...(adding ? { nonce: prepared.body.nonce } : {}),
  } });
  if (!executed.ok) throw new Error(executed.body.error || "Couldn’t confirm the sponsored action. Check its status and try again.");
  const vault = executed.body.vault;
  if (!isAddress(vault, { strict: false }) || vault === zeroAddress || (adding && vault.toLowerCase() !== action.vault.toLowerCase())) {
    throw new Error("Couldn’t verify the vault for this action. Check again.");
  }
  return getAddress(vault);
}
