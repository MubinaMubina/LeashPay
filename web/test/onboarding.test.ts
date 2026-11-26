import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { DEMO_ATTACK_ADDRESS, DEMO_RECIPIENTS, FUNDING_MINIMUM, FUNDING_TARGET } from "@/lib/demo";
import { assertNotAttackAddress, planOnboarding, type OnboardingState } from "@/lib/onboarding";

const VAULT = getAddress("0x1df5aba120b14d2dd3878b876d9676c5a503b3d2");
const [LINH, MARCO, MAI] = DEMO_RECIPIENTS;

const fresh = (): OnboardingState => ({
  vault: VAULT,
  recipients: DEMO_RECIPIENTS.map((recipient) => ({ recipient, allowed: false, monthlyCap: 0n, inDirectory: false })),
  balances: { USDT: 0n, USDC: 0n },
});

const done = (): OnboardingState => ({
  vault: VAULT,
  recipients: DEMO_RECIPIENTS.map((recipient) => ({ recipient, allowed: true, monthlyCap: recipient.monthlyCap, inDirectory: true })),
  balances: { USDT: FUNDING_TARGET, USDC: FUNDING_TARGET },
});

const kinds = (state: OnboardingState) =>
  planOnboarding(state).map((s) => (s.kind === "fund" ? `fund ${s.coin} ${s.amount}` : "recipient" in s ? `${s.kind} ${s.recipient.name}` : s.kind));

describe("planOnboarding", () => {
  it("creates the vault first and plans nothing else until it exists", () => {
    expect(kinds({ ...fresh(), vault: null })).toEqual(["createVault"]);
  });

  it("plans every step for an empty vault, recipients before funding, USDT and USDC both", () => {
    expect(kinds(fresh())).toEqual([
      "allowRecipient Linh",
      "addToDirectory Linh",
      "allowRecipient Marco",
      "addToDirectory Marco",
      "allowRecipient Mai",
      "addToDirectory Mai",
      `fund USDT ${FUNDING_TARGET}`,
      `fund USDC ${FUNDING_TARGET}`,
    ]);
  });

  it("finishes only what is missing after a setup that stopped halfway", () => {
    const half = done();
    half.recipients[1] = { recipient: MARCO, allowed: true, monthlyCap: MARCO.monthlyCap, inDirectory: false };
    half.recipients[2] = { recipient: MAI, allowed: false, monthlyCap: 0n, inDirectory: true };
    half.balances.USDC = 0n;
    expect(kinds(half)).toEqual(["addToDirectory Marco", "allowRecipient Mai", `fund USDC ${FUNDING_TARGET}`]);
  });

  it.each([true, false])("leaves revoked demo recipients disabled (in directory: %s)", (inDirectory) => {
    const state = done();
    state.recipients[0] = { recipient: LINH, allowed: false, monthlyCap: LINH.monthlyCap, inDirectory };
    expect(planOnboarding(state)).toEqual([]);
  });

  it("raises a monthly cap that is below the demo's", () => {
    const state = done();
    state.recipients[0] = { recipient: LINH, allowed: true, monthlyCap: 10n, inDirectory: true };
    expect(kinds(state)).toEqual(["allowRecipient Linh"]);
  });

  it("leaves a balance spent down by payments alone, and tops up only a coin that runs low", () => {
    const state = done();
    state.balances.USDT = FUNDING_TARGET - 3n * 10n ** 18n;
    expect(planOnboarding(state)).toEqual([]);
    state.balances.USDC = FUNDING_MINIMUM - 1n;
    expect(kinds(state)).toEqual([`fund USDC ${FUNDING_TARGET - FUNDING_MINIMUM + 1n}`]);
  });

  it("plans nothing once setup is complete, so re-running it is free", () => {
    expect(planOnboarding(done())).toEqual([]);
  });
});

describe("the demo attack address", () => {
  it("can never be allowlisted by setup", () => {
    const state = fresh();
    state.recipients.push({
      recipient: { ...LINH, name: "Attacker", address: DEMO_ATTACK_ADDRESS },
      allowed: false,
      monthlyCap: 0n,
      inDirectory: false,
    });
    expect(() => planOnboarding(state)).toThrow(/never be added/);
    expect(() => assertNotAttackAddress(getAddress(DEMO_ATTACK_ADDRESS.toLowerCase()))).toThrow();
  });
});
