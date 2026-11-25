import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FACTORY_DEPLOY_BLOCK, chunks, createRecipientHandler, type LogReader } from "@/lib/recipient-logs";

const FACTORY = getAddress("0x80b66347374c6df4f157368497201aa63a371f60");
const VAULT = getAddress("0x1df5aba120b14d2dd3878b876d9676c5a503b3d2");
const IMPOSTOR = getAddress("0x00000000000000000000000000000000000ba5e1");
const USDT = getAddress("0x0081297d056308340e5501b5f2f076344a46ab44");
const MARCO = getAddress("0xebe6e66c61dc57185f2c9a63bbc9914b85a4b13b");
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function reader(over: Partial<LogReader> = {}): LogReader & { paidCalls: [bigint, bigint][] } {
  const paidCalls: [bigint, bigint][] = [];
  return {
    paidCalls,
    getBlockNumber: async () => FACTORY_DEPLOY_BLOCK + 120_000n,
    getVaultCreatedLogs: async (_f: Address, from: bigint) => (from === FACTORY_DEPLOY_BLOCK ? [{ vault: VAULT }] : []),
    getPaidLogs: async (_r: Address, from: bigint, to: bigint) => {
      paidCalls.push([from, to]);
      if (from !== FACTORY_DEPLOY_BLOCK) return [];
      return [
        { address: VAULT, token: USDT, amount: 1n * 10n ** 18n, ref: hash(1), hash: hash(10), block: FACTORY_DEPLOY_BLOCK + 100n },
        { address: VAULT, token: USDT, amount: 450n * 10n ** 18n, ref: hash(2), hash: hash(11), block: FACTORY_DEPLOY_BLOCK + 900n },
        // The same public event emitted by a contract the factory never created.
        { address: IMPOSTOR, token: USDT, amount: 10n ** 24n, ref: hash(3), hash: hash(12), block: FACTORY_DEPLOY_BLOCK + 950n },
      ];
    },
    getBlockTimestamp: async (block) => Number(block),
    ...over,
  };
}

describe("chunks", () => {
  it("covers the range exactly in 50,000-block pieces", () => {
    expect(chunks(0n, 120_000n)).toEqual([
      [0n, 49_999n],
      [50_000n, 99_999n],
      [100_000n, 120_000n],
    ]);
    expect(chunks(5n, 5n)).toEqual([[5n, 5n]]);
  });
});

describe("GET /api/recipient/:address", () => {
  it("lists payments from LeashPay vaults only, newest first, searching from the factory's deploy block", async () => {
    const r = reader();
    const response = await createRecipientHandler({ reader: r, factory: FACTORY })(MARCO.toLowerCase());
    const body = (await response.json()) as { recipient: string; payments: { amount: string; hash: string; vault: string }[] };

    expect(response.status).toBe(200);
    expect(body.recipient).toBe(MARCO);
    expect(body.payments.map((p) => p.hash)).toEqual([hash(11), hash(10)]);
    expect(body.payments.every((p) => p.vault === VAULT)).toBe(true);
    expect(r.paidCalls[0]).toEqual([FACTORY_DEPLOY_BLOCK, FACTORY_DEPLOY_BLOCK + 49_999n]);
    expect(r.paidCalls).toHaveLength(3);
  });

  it("answers an empty list only when the search worked and found nothing", async () => {
    const response = await createRecipientHandler({ reader: reader({ getPaidLogs: async () => [] }), factory: FACTORY })(MARCO);
    expect(await response.json()).toEqual({ recipient: MARCO, payments: [] });
  });

  it("answers an error, never an empty list, when the node fails, without echoing the RPC URL", async () => {
    const failing = reader({
      getPaidLogs: async () => {
        throw new Error("HTTP request failed. URL: https://bsc-testnet.nodereal.io/v1/SECRET-KEY");
      },
    });
    const response = await createRecipientHandler({ reader: failing, factory: FACTORY })(MARCO);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SECRET-KEY");
  });

  it("answers 400 for a non-address and 503 when NodeReal isn't configured", async () => {
    expect((await createRecipientHandler({ reader: reader(), factory: FACTORY })("marco")).status).toBe(400);
    expect((await createRecipientHandler({ reader: null, factory: FACTORY })(MARCO)).status).toBe(503);
  });

  it("caches a result for 30 seconds", async () => {
    let now = 0;
    const r = reader();
    const spy = vi.spyOn(r, "getBlockNumber");
    const handle = createRecipientHandler({ reader: r, factory: FACTORY, now: () => now });
    await handle(MARCO);
    await handle(MARCO);
    expect(spy).toHaveBeenCalledTimes(1);
    now = 30_001;
    await handle(MARCO);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
