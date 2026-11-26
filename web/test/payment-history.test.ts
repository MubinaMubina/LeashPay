import { describe, expect, it, vi } from "vitest";
import { type Address, type Hex } from "viem";
import { createHistoryHandler, sentPaymentsWithFees, type HistoryPage, type HistoryReader, type PaidLog } from "@/lib/payment-history";
import { FACTORY_DEPLOY_BLOCK } from "@/lib/recipient-logs";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const [factory, owner, vault, friend, friendVault, third, thirdVault] = [1, 2, 3, 4, 5, 6, 7].map(address);
const usdt = "0x0081297d056308340e5501b5f2f076344a46ab44";
const usdc = "0xadbbbc9a09f258e6d0184d0d5edb0688db15f421";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const block = FACTORY_DEPLOY_BLOCK + 100n;
const unit = 10n ** 18n;
function paid(index: number, sender = vault, recipient = friend, token: Address = usdt): PaidLog {
  return { address: sender, recipient, token, amount: unit, ref: hash(index), hash: hash(1), block, logIndex: index };
}
const registry = [
  { factory, owner, vault }, { factory, owner: friend, vault: friendVault }, { factory, owner: third, vault: thirdVault },
];
function includesAddress(filter: Address | readonly Address[], address: Address) {
  return (typeof filter === "string" ? [filter] : filter).includes(address);
}
function fixture(logs: PaidLog[], sessionOwner = owner, trusted: Address | readonly Address[] = factory, created = registry) {
  const reader: HistoryReader = {
    getTokens: vi.fn(async () => ({ usdt: usdt as Address, usdc: usdc as Address })),
    finalizedBlock: vi.fn(async () => block),
    getVaultCreatedLogs: vi.fn(async factories => created.filter(pair => includesAddress(factories, pair.factory))),
    getPaidLogs: vi.fn(async (recipients, from, to) => logs.filter(p => includesAddress(recipients, p.recipient)
      && from <= p.block && p.block <= to).map(p => ({ ...p, fee: undefined }))),
    getSentLogs: vi.fn(async (senders, from, to) => logs.filter(p => includesAddress(senders, p.address) && from <= p.block && p.block <= to)),
    getBlockTimestamp: vi.fn(async () => 1_800_000_000),
  };
  const handle = createHistoryHandler({ reader, factory: trusted, resolveOwner: async () => ({ ok: true, owner: sessionOwner }) });
  const request = (query = "") => handle(new Request("http://localhost/api/history?" + query));
  const page = async (query = ""): Promise<HistoryPage> => {
    const response = await request(query);
    expect(response.status).toBe(200);
    return response.json();
  };
  return { page, reader, request };
}

describe("confirmed LeashPay history", () => {
  it("combines both trusted factories in one scan and keeps the net amounts and observed sender fees across pages", async () => {
    const [newFactory, newVault, newFriendVault, outsider, foreignVault] = [11, 12, 13, 14, 15].map(address);
    const created = [...registry, registry[0], { factory: newFactory, owner, vault: newVault },
      { factory: newFactory, owner: friend, vault: newFriendVault }, { factory: outsider, owner: friend, vault: foreignVault }];
    const fee = { token: usdt as Address, amount: unit / 100n };
    const sponsored = paid(11, newVault, newFriendVault, usdc);
    const self = paid(12, newVault, vault);
    const legacy = Array.from({ length: 10 }, (_, i) => paid(i + 1));
    // Two vaults can use the same ref for the same contact in one transaction.
    legacy[0] = { ...paid(1, vault, newFriendVault), ref: sponsored.ref };
    const sent = sentPaymentsWithFees([...legacy, sponsored, self],
      [sponsored, self].map(log => ({ ...log, ...fee, logIndex: log.logIndex + 30 })));
    const incoming = paid(15, friendVault, owner);
    const { page, reader } = fixture([...sent, paid(13, friendVault, newVault, usdc),
      { ...paid(14, newFriendVault, vault), fee }, incoming, incoming, paid(16, foreignVault, owner)],
      owner, [newFactory, factory], created);

    const first = await page();
    expect(first.payments.map(p => p.logIndex)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
    expect(first).toMatchObject({ count: 15, next: `${block}.6`, totals: {
      sent: { USDT: String(11n * unit), USDC: String(unit) }, received: { USDT: String(3n * unit), USDC: String(unit) },
    } });
    expect(first.payments.filter(p => p.fee).map(p => [p.logIndex, p.direction, p.fee])).toEqual([
      [12, "self", { amount: String(unit / 100n), symbol: "USDT" }],
      [11, "sent", { amount: String(unit / 100n), symbol: "USDT" }],
    ]);
    expect(first.payments.find(p => p.logIndex === 14)).toMatchObject({ direction: "received", wallet: friend, vault: newFriendVault });
    const last = await page(`before=${first.next}`);
    expect(last.payments.map(p => p.logIndex)).toEqual([5, 4, 3, 2, 1]);
    expect(last.payments.every(p => p.fee === undefined)).toBe(true);
    expect(last).toMatchObject({ count: 15, next: null, totals: first.totals });
    for (const contact of [friend, friendVault, newFriendVault]) {
      expect((await page(`contact=${contact}`)).count).toBe(14);
    }
    expect(reader.finalizedBlock).toHaveBeenCalledTimes(1);
    expect(reader.getTokens).toHaveBeenCalledExactlyOnceWith(newFactory);
    expect(reader.getVaultCreatedLogs).toHaveBeenCalledExactlyOnceWith([newFactory, factory], FACTORY_DEPLOY_BLOCK, block);
    expect(reader.getPaidLogs).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([owner, vault, newVault]), FACTORY_DEPLOY_BLOCK, block);
    expect(reader.getSentLogs).toHaveBeenCalledExactlyOnceWith(expect.arrayContaining([vault, newVault]), FACTORY_DEPLOY_BLOCK, block);
    expect(vi.mocked(reader.getPaidLogs).mock.calls[0][0]).toHaveLength(3);
    expect(vi.mocked(reader.getSentLogs).mock.calls[0][0]).toHaveLength(2);
  });

  it("pairs on-chain fees with their payout and preserves net sent and received totals", async () => {
    const outgoing = paid(1, vault, friend, usdc);
    const charge = { ...outgoing, token: usdt as Address, amount: unit / 100n, logIndex: 2 };
    const unrelated = { ...charge, recipient: third, amount: unit };
    const legacy = paid(3);
    const logs = sentPaymentsWithFees([outgoing, legacy], [charge, unrelated, { ...charge, hash: hash(2) }]);
    const incoming = { ...paid(4, friendVault, owner), fee: { amount: unit / 100n, token: usdt as Address } };
    const { page } = fixture([...logs, incoming]);
    const result = await page();
    expect(result.payments.find(p => p.logIndex === 1)).toMatchObject({ amount: String(unit), symbol: "USDC",
      fee: { amount: String(unit / 100n), symbol: "USDT" } });
    expect(result.payments.find(p => p.logIndex === 3)?.fee).toBeUndefined();
    expect(result.payments.find(p => p.logIndex === 4)?.fee).toBeUndefined();
    expect(result.totals).toEqual({ sent: { USDT: String(unit), USDC: String(unit) }, received: { USDT: String(unit), USDC: "0" } });
  });

  it("keeps only finalized payments involving this owner and issued by a factory vault", async () => {
    const { page, reader } = fixture([paid(1), paid(2, friendVault, owner, usdc), paid(3, friendVault, vault),
      paid(4, thirdVault, friend), paid(5, address(99), owner), { ...paid(6), block: block + 1n }]);
    const result = await page();
    expect(result.payments.map(p => [p.logIndex, p.direction, p.wallet])).toEqual([
      [3, "received", friend], [2, "received", friend], [1, "sent", friend]]);
    expect(result.totals).toEqual({ sent: { USDT: String(unit), USDC: "0" }, received: { USDT: String(unit), USDC: String(unit) } });
    expect(reader.getBlockTimestamp).toHaveBeenCalledTimes(1);
    expect(reader.getVaultCreatedLogs).toHaveBeenCalledWith(factory, FACTORY_DEPLOY_BLOCK, block);
  });
  it("uses the configured factory’s stablecoins and keeps fractional units intact", async () => {
    const token = address(33);
    const { page, reader } = fixture([{ ...paid(1, vault, friend, token), amount: 1n }]);
    vi.mocked(reader.getTokens).mockResolvedValue({ usdt: token, usdc: address(34) });
    expect((await page()).payments[0]).toMatchObject({ amount: "1", symbol: "USDT" });
    expect(reader.getTokens).toHaveBeenCalledWith(factory);
  });
  it("refreshes a reopened view after confirmation and reuses the snapshot for pagination", async () => {
    const logs = [paid(1)];
    const { page, reader } = fixture(logs);
    const now = vi.spyOn(Date, "now").mockReturnValue(100000);
    try {
      expect((await page()).count).toBe(1);
      logs.push(paid(2));
      now.mockReturnValue(103000);
      expect((await page("fresh=1")).count).toBe(2);
      expect((await page("fresh=1&before=1.0")).payments).toEqual([]);
      expect(reader.finalizedBlock).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
  it("shows incoming wallet payments before vault activation and performs no outgoing search", async () => {
    const guestWallet = address(22);
    const { page, reader } = fixture([paid(7, friendVault, guestWallet)], guestWallet);
    expect((await page("filter=received")).payments[0]).toMatchObject({ direction: "received", wallet: friend });
    expect(reader.getSentLogs).not.toHaveBeenCalled();
    expect((await page("filter=sent")).payments).toEqual([]);
  });
  it("matches contact wallet and vault aliases in both directions and excludes unrelated receipts", async () => {
    const { page } = fixture([paid(1, vault, friendVault), paid(2, friendVault, owner), paid(3, vault, third),
      paid(4, thirdVault, vault), paid(5, friendVault, third)]);
    for (const contact of [friend, friendVault]) {
      const all = await page(`contact=${contact}`);
      expect(all.payments.map(p => p.logIndex)).toEqual([2, 1]);
      expect(all.totals.sent.USDT).toBe(String(unit));
      expect(all.totals.received.USDT).toBe(String(unit));
    }
  });
  it("paginates more than 50 receipts, orders ties, and totals the entire contact history", async () => {
    const outgoing = Array.from({ length: 54 }, (_, i) => paid(i));
    const { page, reader } = fixture([...outgoing, paid(54, friendVault, owner, usdc)]);
    let result = await page(`filter=sent&contact=${friend}`);
    expect(result.payments.map(p => p.logIndex)).toEqual([53,52,51,50,49,48,47,46,45,44]);
    expect(result.count).toBe(54);
    expect(result.totals.sent.USDT).toBe(String(54n * unit));
    expect(result.totals.received.USDC).toBe(String(unit));
    const ids = result.payments.map(p => p.logIndex);
    while (result.next) {
      result = await page(`filter=sent&contact=${friend}&before=${result.next}`);
      ids.push(...result.payments.map(p => p.logIndex));
    }
    expect(ids).toEqual(outgoing.map(p => p.logIndex).reverse());
    expect(reader.finalizedBlock).toHaveBeenCalledTimes(1);
  });
  it("lists a payment to the owner's wallet only once when both searches match it", async () => {
    const { page } = fixture([paid(1, vault, owner)]);
    expect((await page()).payments).toHaveLength(1);
    expect((await page("filter=sent")).payments[0].direction).toBe("self");
    expect((await page("filter=received")).payments[0].direction).toBe("self");
  });
  it("rejects invalid pagination and only uses the verified owner", async () => {
    const { request, page, reader } = fixture([paid(1), paid(2, thirdVault, friend)]);
    for (const q of ["filter=none", "contact=abc", "before=-5.6", "before=1.2.3"]) expect((await request(q)).status).toBe(400);
    expect(reader.finalizedBlock).not.toHaveBeenCalled();
    expect((await page(`owner=${third}`)).payments.map(p => p.logIndex)).toEqual([1]);
    const handle = createHistoryHandler({ factory, reader, resolveOwner: async () => ({ ok: false, status: 401, error: "Log in" }) });
    const response = await handle(new Request("http://localhost/api/history"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("fails closed before issuing an unscoped query when the trusted factory set is empty", async () => {
    const { request, reader } = fixture([paid(1)], owner, []);
    expect((await request()).status).toBe(502);
    expect(reader.getVaultCreatedLogs).not.toHaveBeenCalled();
    expect(reader.getPaidLogs).not.toHaveBeenCalled();
  });
  it("recovers from an RPC failure without presenting an empty history or leaking the RPC key", async () => {
    const { page, request, reader } = fixture([paid(1)]);
    vi.mocked(reader.finalizedBlock).mockRejectedValueOnce(new Error("secret-rpc-key"));
    const failure = await request();
    expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("secret-rpc-key");
    expect((await page()).count).toBe(1);
  });
});
