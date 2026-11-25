import { BaseError, ContractFunctionRevertedError, decodeErrorResult, formatUnits, type Hex } from "viem";
import { leashVaultAbi, leashVaultFactoryAbi } from "../abi/generated";

type AbiItem = (typeof leashVaultAbi)[number] | (typeof leashVaultFactoryAbi)[number];
type ErrorItem = Extract<AbiItem, { type: "error" }>;

/** Every custom error the vault or the factory can revert with (from the frozen ABI). */
export type VaultErrorName = ErrorItem["name"];

const errorAbi = [...leashVaultAbi, ...leashVaultFactoryAbi].filter((item): item is ErrorItem => item.type === "error");

/** A vault refusal, decoded and explained. `args` are stringified for JSON. */
export interface VaultRevert {
  name: string;
  args: string[];
  message: string;
}

/** Thrown when the vault refuses a call during simulation, so nothing was sent. */
export class VaultRevertError extends Error {
  constructor(readonly revert: VaultRevert) {
    super(revert.message);
    this.name = "VaultRevertError";
  }
}

/** Lower-cased token address -> display symbol, for messages like "Not enough USDT". */
export type TokenNames = Record<string, string>;

const short = (value: unknown) => {
  const a = String(value);
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
};
const usd = (value: unknown) => `$${formatUnits(BigInt(value as bigint), 18)}`;
const time = (value: unknown) => {
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime())
    ? `timestamp ${String(value)}`
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

type Describe = (args: readonly unknown[], symbol: (token: unknown) => string) => string;

// Mirrors the "Message to show" column of docs/vault-abi.md. The Record type makes
// the compiler reject this file if an error is added to the ABI without a message.
const MESSAGES: Record<VaultErrorName, Describe> = {
  Unauthorized: ([caller]) => `Not allowed: ${short(caller)} doesn't have the role this action needs.`,
  VaultPaused: () => "The vault is paused by its owner. Nothing goes out until it's resumed.",
  ZeroAddress: () => "An address is missing.",
  ZeroAmount: () => "The amount must be more than zero.",
  InvalidRef: () => "Internal error: the payment has no plan reference.",
  InvalidRules: () =>
    "These rules don't fit together. Check the caps, the slippage limit (2% max) and the price floor ($1 max).",
  TokenNotAllowed: ([token], symbol) => `${symbol(token)} isn't enabled for this vault.`,
  RecipientNotAllowed: ([recipient]) => `Blocked: ${short(recipient)} isn't on your recipient list.`,
  DuplicatePayment: ([, recipient]) => `${short(recipient)} was already paid for this plan. Nothing was sent twice.`,
  ExceedsPaymentCap: ([amount, cap]) => `${usd(amount)} is over the ${usd(cap)} limit per payment.`,
  ExceedsDailyCap: ([amount, remaining]) =>
    `Only ${usd(remaining)} is left in today's limit (${usd(amount)} requested).`,
  ExceedsMonthlyCap: ([recipient, amount, remaining]) =>
    `Only ${usd(remaining)} is left for ${short(recipient)} this month (${usd(amount)} requested).`,
  CooldownActive: ([recipient, readyAt]) =>
    `${short(recipient)} was paid recently. The next payment is possible at ${time(readyAt)}.`,
  InsufficientBalance: ([token, available, needed], symbol) =>
    `Not enough ${symbol(token)}: ${formatUnits(BigInt(available as bigint), 18)} available, ${formatUnits(BigInt(needed as bigint), 18)} needed.`,
  PriceFeedNotSet: ([token], symbol) => `No price feed is set for ${symbol(token)}.`,
  InvalidPrice: ([token], symbol) => `The price feed for ${symbol(token)} returned an invalid price.`,
  StalePrice: ([token, updatedAt], symbol) =>
    `The ${symbol(token)} price is out of date (last update ${time(updatedAt)}).`,
  PriceBelowFloor: ([token, price, floor], symbol) =>
    `${symbol(token)} trades at ${usd(price)}, below your ${usd(floor)} floor, so paying in it is blocked.`,
  SlippageTooHigh: ([minAmountOut, actualAmountOut]) =>
    `The swap would return ${formatUnits(BigInt(actualAmountOut as bigint), 18)}, below the minimum ${formatUnits(BigInt(minAmountOut as bigint), 18)}. Cancelled.`,
  ExceedsSwapCap: ([, remaining]) => `Only ${usd(remaining)} of today's swap limit is left.`,
  VaultAlreadyExists: ([, vault]) => `You already have a vault (${short(vault)}).`,
};

/** Explains a decoded vault error. Unknown names get a generic message. */
export function describeVaultError(name: string, args: readonly unknown[], tokens: TokenNames = {}): VaultRevert {
  const symbol = (token: unknown) => tokens[String(token).toLowerCase()] ?? short(token);
  const describe = (MESSAGES as Record<string, Describe | undefined>)[name];
  return {
    name,
    args: args.map((arg) => String(arg)),
    message: describe ? describe(args, symbol) : `The vault refused this transaction (${name}).`,
  };
}

/** Decodes raw revert data (0x + selector + args) against the vault and factory errors. */
export function decodeRevertData(data: Hex, tokens: TokenNames = {}): VaultRevert {
  let decoded: ReturnType<typeof decodeErrorResult<typeof errorAbi>>;
  try {
    decoded = decodeErrorResult({ abi: errorAbi, data });
  } catch {
    return { name: "Unknown", args: [data], message: `The vault refused this transaction (error ${data.slice(0, 10)}).` };
  }
  return describeVaultError(decoded.errorName, decoded.args ?? [], tokens);
}

/** Finds a contract revert inside any viem error. Returns null for non-revert failures (RPC down, etc.). */
export function decodeRevert(err: unknown, tokens: TokenNames = {}): VaultRevert | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  if (reverted.data?.errorName) return describeVaultError(reverted.data.errorName, reverted.data.args ?? [], tokens);
  if (reverted.raw) return decodeRevertData(reverted.raw, tokens);
  return {
    name: "Unknown",
    args: [],
    message: `The vault refused this transaction (${reverted.reason ?? reverted.signature ?? "no reason given"}).`,
  };
}
