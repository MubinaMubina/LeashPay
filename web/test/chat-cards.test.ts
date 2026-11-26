import { describe, expect, it } from "vitest";
import { parseVaultBalances, recipientPage } from "@/lib/chat-cards";
import type { ListedRecipient } from "@/lib/recipients";

function recipient(name: string, n: number, allowed: boolean | null = true): ListedRecipient {
  return {
    name,
    address: `0x${String(n).padStart(40, "0")}`,
    onChain: allowed === null ? null : { allowed, monthlyCap: 200n * 10n ** 18n, spentThisMonth: 0n },
  };
}

describe("recipient preview", () => {
  const people = [recipient("Marco", 1), recipient("Linh", 2), recipient("Léa", 3), recipient("Ana", 4)];

  it.each([0, 1, 3])("fits %i verified recipients on one page", (length) => {
    const result = recipientPage(people.slice(0, length), 0);
    expect(result).toMatchObject({ total: length, page: 0, hasNext: false, unverified: false });
    expect(result.rows).toHaveLength(length);
  });

  it("pages by name, excludes disabled, unknown and unnamed entries, and preserves the directory order", () => {
    const input = [...people, recipient("Ben", 5, false), recipient("Bo", 6, null), recipient(" ", 7)];
    const first = recipientPage(input, 0);
    expect(first.rows.map((row) => row.name)).toEqual(["Ana", "Léa", "Linh"]);
    expect(first).toMatchObject({ total: 4, first: 1, last: 3, hasNext: true, unverified: true });
    const second = recipientPage(input, 1);
    expect(second.rows.map((row) => row.name)).toEqual(["Marco"]);
    expect(second).toMatchObject({ page: 1, first: 4, last: 4, hasNext: false });
    expect(input[0].name).toBe("Marco");
  });

  it("returns to a valid page when a refreshed vault has fewer allowed recipients", () => {
    expect(recipientPage(people.slice(0, 2), 1)).toMatchObject({ page: 0, first: 1, last: 2 });
  });

  it("distinguishes an unverified directory from one with no eligible entries", () => {
    expect(recipientPage([recipient("Bo", 6, null)], 0)).toMatchObject({ total: 0, unverified: true });
    expect(recipientPage([recipient("Bo", 6, false)], 0)).toMatchObject({ total: 0, unverified: false });
  });
});

describe("vault balance card", () => {
  it("preserves separately denominated token and T-bill values, including confirmed zero", () => {
    const balances = { USDT: "0", USDC: "7210000000000000000", tbillValue: "19000000000000000000" };
    expect(parseVaultBalances(balances)).toEqual(balances);
  });

  it.each([
    null,
    undefined,
    {},
    { USDT: "0", USDC: "0" },
    { USDT: "0", USDC: null, tbillValue: "0" },
    { USDT: "1.5", USDC: "0", tbillValue: "0" },
  ])("treats a missing or malformed snapshot as unavailable", (balances) => {
    expect(parseVaultBalances(balances)).toBeNull();
  });
});
