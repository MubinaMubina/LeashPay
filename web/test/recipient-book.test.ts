import { encodeAbiParameters, encodeEventTopics, type Address, type Log } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { describe, expect, it, vi } from "vitest";
import { readCapForEdit, refreshRecipientList, verifyCapReceipt } from "@/lib/recipient-book";
import type { ListedRecipient } from "@/lib/recipients";

// These tests control directory completion order independently of Privy and RPC.
const { rpc } = vi.hoisted(() => ({ rpc: { getBlockNumber: vi.fn(), getTransactionCount: vi.fn(), readContract: vi.fn() } }));
vi.mock("@/lib/client", () => ({ errorText: (err: Error) => err.message, publicClient: rpc }));

const lea: ListedRecipient = { name: "Léa", address: "0x4444444444444444444444444444444444444444", onChain: null };

function pendingDirectory() {
  let finish!: (entries: ListedRecipient[]) => void;
  const read = new Promise<ListedRecipient[]>((resolve) => { finish = resolve; });
  return { read: () => read, finish };
}

describe("concurrent recipient book reads", () => {
  it("returns data to both same-owner callers and publishes only the latest refresh", async () => {
    const scope = { active: true, request: 0 };
    const published: (ListedRecipient[] | null)[] = [];
    const publish = ({ list }: { list: ListedRecipient[] | null }) => published.push(list);
    const first = pendingDirectory();
    const validation = refreshRecipientList(scope, first.read, publish);
    const preview = refreshRecipientList(scope, async () => [lea], publish);
    expect(await preview).toEqual([lea]);
    first.finish([]);
    expect(await validation).toEqual([]);
    expect(published).toEqual([[lea]]);
  });

  it("discards pending reads when the owner or vault changes", async () => {
    const previous = { active: true, request: 0 };
    const next = { active: true, request: 0 };
    const published: (ListedRecipient[] | null)[] = [];
    const publish = ({ list }: { list: ListedRecipient[] | null }) => published.push(list);
    const first = pendingDirectory();
    const oldOwner = refreshRecipientList(previous, first.read, publish);
    previous.active = false;
    expect(await refreshRecipientList(next, async () => [], publish)).toEqual([]);
    first.finish([lea]);
    expect(await oldOwner).toBeNull();
    expect(published).toEqual([[]]);
  });
});

describe("a wallet-confirmed cap edit", () => {
  const vault: Address = "0x1111111111111111111111111111111111111111";
  const owner: Address = "0x2222222222222222222222222222222222222222";
  it("reads allowance and owner nonce at the same block and rejects an intervening wallet transaction", async () => {
    rpc.getBlockNumber.mockResolvedValue(700n);
    rpc.readContract.mockResolvedValue([true, 300n, 20n, 0n]);
    rpc.getTransactionCount.mockResolvedValue(4);
    expect(await readCapForEdit(vault, lea.address, owner)).toEqual({
      authorization: { allowed: true, monthlyCap: 300n, spentThisMonth: 20n }, nonce: 4,
    });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: vault, blockNumber: 700n }));
    expect(rpc.getTransactionCount).toHaveBeenCalledWith({ address: owner, blockNumber: 700n });
    rpc.getTransactionCount.mockResolvedValueOnce(4).mockResolvedValueOnce(5);
    await expect(readCapForEdit(vault, lea.address, owner)).rejects.toThrow(/another transaction/);
  });
  it("only accepts a receipt containing the requested cap change at this vault", () => {
    const log = {
      address: vault,
      topics: encodeEventTopics({ abi: leashVaultAbi, eventName: "RecipientUpdated", args: { recipient: lea.address } }),
      data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [true, 300n]),
    } as Log;
    expect(() => verifyCapReceipt({ logs: [log] }, vault, lea.address, 300n)).not.toThrow();
    for (const logs of [[], [{ ...log, address: owner }], [{ ...log, data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }], [false, 300n]) }]]) {
      expect(() => verifyCapReceipt({ logs }, vault, lea.address, 300n)).toThrow(/receipt/);
    }
    expect(() => verifyCapReceipt({ logs: [log] }, vault, lea.address, 301n)).toThrow(/receipt/);
    expect(() => verifyCapReceipt({ logs: [log] }, vault, owner, 300n)).toThrow(/receipt/);
  });
});
