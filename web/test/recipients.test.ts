import { getAddress, parseUnits, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { DEMO_ATTACK_ADDRESS, DEMO_RECIPIENTS } from "@/lib/demo";
import {
  checkNewRecipient, reviewRecipient, saveReviewedRecipient, type ListedRecipient, type NewRecipient, type RecipientForm, type Reserved,
} from "@/lib/recipients";

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

describe("reviewing and saving a recipient", () => {
  // These stand in for the directory and the vault. A new form always reads the same underlying state.
  function setup() {
    const state = {
      directory: [] as ListedRecipient[] | null,
      vault: { allowed: false, monthlyCap: 0n, spentThisMonth: 0n } as ListedRecipient["onChain"],
      signatures: 0,
      nameWrites: 0,
      saveFails: false,
      reverted: false,
    };
    const reads = {
      directory: async () => state.directory,
      authorization: async () => state.vault,
    };
    const inspect = () => reviewRecipient(form(), RESERVED, reads);
    const writes = {
      authorize: async ({ address, monthlyCap }: NewRecipient) => {
        state.signatures++;
        if (address !== RAMON) throw new Error("Unexpected wallet address");
        if (state.reverted) throw new Error("The transaction failed on-chain");
        state.vault = { allowed: true, monthlyCap, spentThisMonth: 0n };
      },
      saveName: async ({ name, address, country, currency }: NewRecipient) => {
        state.nameWrites++;
        if (state.saveFails) throw new Error("Directory offline");
        state.directory = [{ name, address, country, currency, onChain: state.vault }];
      },
    };
    return { state, inspect, writes };
  }

  it("reviews the full recipient and cap without signing or writing", async () => {
    const { state, inspect } = setup();
    expect(await inspect()).toMatchObject({ action: "authorize", recipient: { address: RAMON, monthlyCap: 1000n * 10n ** 18n } });
    expect([state.signatures, state.nameWrites]).toEqual([0, 0]);
  });

  it.each(["retry", "remount"])("only saves the name after partial success and %s", async (path) => {
    const { state, inspect, writes } = setup();
    state.saveFails = true;
    const result = await saveReviewedRecipient(await inspect(), inspect, writes);
    expect(result.kind).toBe("retry-name");
    if (result.kind !== "retry-name") throw new Error("Expected a recoverable directory failure");
    state.saveFails = false;
    const review = path === "retry" ? result.review : await inspect();
    expect(review.action).toBe("save-name");
    expect((await saveReviewedRecipient(review, inspect, writes)).kind).toBe("added");
    expect(state.signatures).toBe(1);
    expect(state.directory).toEqual([{
      name: "Ramon", address: RAMON, country: "PH", currency: "PHP",
      onChain: { allowed: true, monthlyCap: 1000n * 10n ** 18n, spentThisMonth: 0n },
    }]);
  });

  it("requires a fresh review if another tab changes the cap before a name-only retry", async () => {
    const { state, inspect, writes } = setup();
    state.vault = { allowed: true, monthlyCap: parseUnits("1000", 18), spentThisMonth: 0n };
    const reviewed = await inspect();
    state.vault.monthlyCap = parseUnits("200", 18);
    const changed = await saveReviewedRecipient(reviewed, inspect, writes);
    expect(changed).toMatchObject({ kind: "changed", review: { action: "authorize", currentCap: 200n * 10n ** 18n } });
    expect([state.signatures, state.nameWrites]).toEqual([0, 0]);
  });

  it("never signs when the recipient directory or target vault entry is unreadable", async () => {
    const { state, inspect, writes } = setup();
    const reviewed = await inspect();
    state.directory = null;
    await expect(saveReviewedRecipient(reviewed, inspect, writes)).rejects.toThrow(/directory/i);
    state.directory = [];
    state.vault = null;
    await expect(saveReviewedRecipient(reviewed, inspect, writes)).rejects.toThrow(/vault/i);
    expect([state.signatures, state.nameWrites]).toEqual([0, 0]);
  });

  it("rejects a conflicting directory name even if the existing address is disabled", async () => {
    const { state, inspect } = setup();
    state.directory = [{ name: "Other name", address: RAMON, onChain: state.vault }];
    await expect(inspect()).rejects.toThrow(/Other name/);
  });

  it("never saves a name if the wallet denies the request or the receipt reports failure", async () => {
    const { state, inspect, writes } = setup();
    state.reverted = true;
    await expect(saveReviewedRecipient(await inspect(), inspect, writes)).rejects.toThrow(/transaction failed/);
    expect(state.nameWrites).toBe(0);
  });

  it("keeps an intervening directory entry if the address was claimed during wallet confirmation", async () => {
    const { state, inspect, writes } = setup();
    const outcome = await saveReviewedRecipient(await inspect(), inspect, {
      ...writes,
      authorize: async (recipient) => {
        await writes.authorize(recipient);
        state.directory = [{ name: "Other name", address: RAMON, onChain: state.vault }];
      },
    });
    expect(outcome).toMatchObject({ kind: "retry-name", error: expect.stringContaining("Other name") });
    expect(state.nameWrites).toBe(0);
    expect(state.directory?.[0]?.name).toBe("Other name");
  });

  it("recognizes a completed save after an uncertain response without another write", async () => {
    const { state, inspect, writes } = setup();
    const reviewed = await inspect();
    state.vault = { allowed: true, monthlyCap: parseUnits("1000", 18), spentThisMonth: 0n };
    state.directory = [{ name: "Ramon", address: RAMON, onChain: state.vault }];
    expect((await saveReviewedRecipient(reviewed, inspect, writes)).kind).toBe("added");
    expect([state.signatures, state.nameWrites]).toEqual([0, 0]);
  });
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
