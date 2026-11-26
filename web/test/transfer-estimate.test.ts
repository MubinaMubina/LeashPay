import { describe, expect, it } from "vitest";
import { estimateBankTransfer } from "@/lib/transfer-estimate";

describe("illustrative bank transfer fee", () => {
  it("deducts the fee from the bank deposit and adds it to a requested bank payout", () => {
    expect(estimateBankTransfer(200, "deposit")).toEqual({ feeUsd: 2, vaultUsd: 198 });
    expect(estimateBankTransfer(200, "withdraw")).toEqual({ feeUsd: 2, vaultUsd: 202 });
  });

  it("rounds the fee to whole cents before applying it", () => {
    expect(estimateBankTransfer(100.49, "deposit")).toEqual({ feeUsd: 1, vaultUsd: 99.49 });
    expect(estimateBankTransfer(100.50, "withdraw")).toEqual({ feeUsd: 1.01, vaultUsd: 101.51 });
    expect(estimateBankTransfer(0.01, "deposit")).toEqual({ feeUsd: 0, vaultUsd: 0.01 });
  });
});
