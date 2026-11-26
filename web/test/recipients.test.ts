import { getAddress, parseUnits, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { DEMO_ATTACK_ADDRESS, DEMO_RECIPIENTS } from "@/lib/demo";
import { checkNewRecipient, type ListedRecipient, type RecipientForm, type Reserved } from "@/lib/recipients";

const RESERVED: Reserved = {
  owner: getAddress("0x1111111111111111111111111111111111111111"),
  vault: getAddress("0x2222222222222222222222222222222222222222"),
  agent: getAddress("0x3333333333333333333333333333333333333333"),
};
const RAMON = "0x4444444444444444444444444444444444444444";
const [LINH] = DEMO_RECIPIENTS;

const form = (over: Partial<RecipientForm> = {}): RecipientForm => ({
  name: "Ramon",
  address: RAMON,
  country: "PH",
  currency: "PHP",
  monthlyCap: "1000",
  ...over,
});

const linh = (allowed: boolean): ListedRecipient => ({
  name: "Linh",
  address: LINH.address,
  country: "VN",
  currency: "VND",
  onChain: { allowed, monthlyCap: allowed ? LINH.monthlyCap : 0n, spentThisMonth: 0n },
});

const errorOf = (f: RecipientForm, existing: ListedRecipient[] = [linh(true)]) => {
  const result = checkNewRecipient(f, existing, RESERVED);
  return result.ok ? null : result.error;
};

describe("checkNewRecipient", () => {
  it("accepts a complete form and returns the cap in 18-decimal units with a checksummed address", () => {
    const result = checkNewRecipient(form({ name: "  Ramon ", address: RAMON.toUpperCase().replace("0X", "0x") }), [linh(true)], RESERVED);
    expect(result).toEqual({
      ok: true,
      recipient: { name: "Ramon", address: getAddress(RAMON), country: "PH", currency: "PHP", monthlyCap: parseUnits("1000", 18) },
    });
  });

  it("leaves the country out when it's blank, and accepts a decimal cap", () => {
    const result = checkNewRecipient(form({ country: " ", monthlyCap: "250.5" }), [], RESERVED);
    expect(result.ok && result.recipient).toEqual({
      name: "Ramon",
      address: getAddress(RAMON),
      currency: "PHP",
      monthlyCap: parseUnits("250.5", 18),
    });
  });

  it("needs a name and a real address", () => {
    expect(errorOf(form({ name: " " }))).toMatch(/name/);
    expect(errorOf(form({ address: "0x1234" }))).toMatch(/isn't a wallet address/);
    expect(errorOf(form({ address: "Ramon's wallet" }))).toMatch(/isn't a wallet address/);
  });

  it("refuses addresses that must never be paid: zero, the demo attack, the vault, the agent and the owner", () => {
    expect(errorOf(form({ address: zeroAddress }))).toMatch(/zero address/);
    expect(errorOf(form({ address: DEMO_ATTACK_ADDRESS.toLowerCase() }))).toMatch(/demo attack/);
    expect(errorOf(form({ address: RESERVED.vault }))).toMatch(/vault's own/);
    expect(errorOf(form({ address: RESERVED.agent!.toLowerCase() }))).toMatch(/agent/);
    expect(errorOf(form({ address: RESERVED.owner }))).toMatch(/your own wallet/);
  });

  it("refuses an address that is already a recipient, but lets an interrupted add finish", () => {
    expect(errorOf(form({ name: "Linh 2", address: LINH.address }))).toMatch(/Linh already has this address/);
    // In the directory but not allowed in the vault (the wallet popup was closed): submitting again finishes it.
    expect(errorOf(form({ name: "Linh", address: LINH.address }), [linh(false)])).toBeNull();
  });

  it("keeps names unique whatever the case, so \"pay linh\" can only mean one person", () => {
    expect(errorOf(form({ name: "LINH" }))).toMatch(/already have a recipient named Linh/);
  });

  it("only takes the listed currencies", () => {
    expect(errorOf(form({ currency: "EUR" }))).toMatch(/Pick a currency/);
    expect(errorOf(form({ currency: "php" }))).toMatch(/Pick a currency/);
    expect(errorOf(form({ currency: "USD" }))).toBeNull();
  });

  it("needs a positive, plain-number monthly cap", () => {
    expect(errorOf(form({ monthlyCap: "0" }))).toMatch(/more than 0/);
    expect(errorOf(form({ monthlyCap: "-5" }))).toMatch(/as a number/);
    expect(errorOf(form({ monthlyCap: "1,000" }))).toMatch(/as a number/);
    expect(errorOf(form({ monthlyCap: "1e3" }))).toMatch(/as a number/);
    expect(errorOf(form({ monthlyCap: "2000000000" }))).toMatch(/too large/);
  });

  it("skips the agent check for a vault that has no agent", () => {
    expect(checkNewRecipient(form({ address: RESERVED.agent! }), [], { ...RESERVED, agent: null }).ok).toBe(true);
  });
});
