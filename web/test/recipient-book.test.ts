import { describe, expect, it, vi } from "vitest";
import { refreshRecipientList } from "@/lib/recipient-book";
import type { ListedRecipient } from "@/lib/recipients";

// These tests control directory completion order independently of Privy and RPC.
vi.mock("@/lib/client", () => ({ errorText: (err: Error) => err.message }));

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
