import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { DEMO_RECIPIENTS, FUNDING_MINIMUM, FUNDING_TARGET } from "@/lib/demo";
import { planOnboarding, type OnboardingState } from "@/lib/onboarding";

const VAULT = getAddress("0x1df5aba120b14d2dd3878b876d9676c5a503b3d2");
const empty = { USDT: 0n, USDC: 0n };

describe("planOnboarding", () => {
  it("sets up a fresh account in three confirmations: create, fund USDT, fund USDC", () => {
    expect(planOnboarding({ vault: null, balances: empty })).toEqual([{ kind: "createVault" }]);
    expect(planOnboarding({ vault: VAULT, balances: empty })).toEqual([
      { kind: "fund", coin: "USDT", amount: FUNDING_TARGET },
      { kind: "fund", coin: "USDC", amount: FUNDING_TARGET },
    ]);
  });

  it("resumes a partially funded vault by topping up only the missing amount", () => {
    const balance = FUNDING_MINIMUM - 1n;
    expect(planOnboarding({ vault: VAULT, balances: { USDT: FUNDING_TARGET, USDC: balance } })).toEqual([
      { kind: "fund", coin: "USDC", amount: FUNDING_TARGET - balance },
    ]);
  });

  it("opens a funded vault with an empty directory and leaves legacy recipients and caps alone", () => {
    const funded: OnboardingState = { vault: VAULT, balances: { USDT: FUNDING_MINIMUM, USDC: FUNDING_TARGET } };
    expect(planOnboarding(funded)).toEqual([]);
    const oldSetup = {
      ...funded,
      recipients: [{ recipient: DEMO_RECIPIENTS[1], allowed: true, monthlyCap: 1n, inDirectory: false }],
    };
    expect(planOnboarding(oldSetup)).toEqual([]);
  });
});
