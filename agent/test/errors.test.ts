import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type AbiParameter, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { leashVaultAbi, leashVaultFactoryAbi } from "../src/abi/generated";
import { decodeRevert, decodeRevertData, describeVaultError } from "../src/chain/errors";
import { ATTACKER, USDT, short } from "./fakes";

const errorItems = [...leashVaultAbi, ...leashVaultFactoryAbi].filter((item) => item.type === "error");

function sampleArg(param: AbiParameter): unknown {
  if (param.type === "address") return ATTACKER;
  if (param.type === "bytes32") return `0x${"ab".repeat(32)}`;
  if (param.type === "int256") return -1n;
  return 10n ** 18n; // uint256
}

describe("vault error messages", () => {
  it.each(errorItems.map((item) => [item.name, item] as const))("%s decodes to its own message", (name, item) => {
    const data = encodeErrorResult({
      abi: [item],
      errorName: name,
      args: item.inputs.map(sampleArg),
    } as Parameters<typeof encodeErrorResult>[0]);

    const revert = decodeRevertData(data);

    expect(revert.name).toBe(name);
    expect(revert.message).not.toContain("refused this transaction"); // a specific message, not the fallback
    expect(revert.args).toHaveLength(item.inputs.length);
  });

  it("names tokens when it knows them", () => {
    const revert = describeVaultError("InsufficientBalance", [USDT, 10n ** 18n, 3n * 10n ** 18n], {
      [USDT.toLowerCase()]: "USDT",
    });
    expect(revert.message).toBe("Not enough USDT: 1 available, 3 needed.");
  });

  it("explains the attack demo's refusal", () => {
    const data = encodeErrorResult({ abi: leashVaultAbi, errorName: "RecipientNotAllowed", args: [ATTACKER] });
    expect(decodeRevertData(data).message).toBe(`Blocked: ${short(ATTACKER)} isn't on your recipient list.`);
  });

  it("falls back to a generic message for errors outside the ABI", () => {
    const revert = decodeRevertData("0xdeadbeef" as Hex);
    expect(revert.name).toBe("Unknown");
    expect(revert.message).toContain("0xdeadbeef");
  });

  it("finds the revert inside a viem error", () => {
    const data = encodeErrorResult({ abi: leashVaultAbi, errorName: "VaultPaused" });
    const err = new ContractFunctionRevertedError({ abi: leashVaultAbi, data, functionName: "pay" });
    expect(decodeRevert(err)?.name).toBe("VaultPaused");
  });

  it("returns null for failures that aren't reverts", () => {
    expect(decodeRevert(new BaseError("network down"))).toBeNull();
    expect(decodeRevert(new Error("boom"))).toBeNull();
  });
});
