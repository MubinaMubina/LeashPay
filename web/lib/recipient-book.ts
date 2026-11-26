import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";
import { leashVaultAbi } from "./abi.generated";
import { errorText, publicClient, useApi, useOwnerWallet } from "./client";
import type { ListedRecipient } from "./recipients";

export interface RecipientBook {
  list: ListedRecipient[] | null;
  error: string | null;
  refresh: () => Promise<ListedRecipient[] | null>;
}

type DirectoryEntry = Omit<ListedRecipient, "onChain">;
type BookData = Pick<RecipientBook, "list" | "error">;

export async function refreshRecipientList(
  scope: { active: boolean; request: number },
  read: () => Promise<ListedRecipient[]>,
  publish: (state: BookData) => void,
): Promise<ListedRecipient[] | null> {
  if (!scope.active) return null;
  const request = ++scope.request;
  const current = () => scope.active && request === scope.request;
  try {
    const list = await read();
    if (!scope.active) return null;
    // Each caller gets the read it started. Only the newest request updates the shared UI.
    if (current()) publish({ list, error: null });
    return list;
  } catch (err) {
    if (current()) publish({ list: null, error: errorText(err) });
    return null;
  }
}

export async function readRecipientAuthorization(vault: Address, recipient: Address): Promise<ListedRecipient["onChain"]> {
  try {
    const [allowed, monthlyCap, spentThisMonth] = await publicClient.readContract({
      address: vault, abi: leashVaultAbi, functionName: "recipientInfo", args: [recipient],
    });
    return { allowed, monthlyCap, spentThisMonth };
  } catch {
    return null;
  }
}

export function useRecipientBook(vault: Address): RecipientBook {
  const api = useApi();
  const owner = useOwnerWallet()?.address;
  // Responses from an earlier owner, vault, or overlapping refresh cannot replace the current list.
  const scope = useMemo(() => ({ owner, vault, active: true, request: 0 }), [owner, vault]);
  const [data, setData] = useState<BookData & { scope: typeof scope } | null>(null);
  const refresh = useCallback(async () => {
    if (!scope.owner) return null;
    return refreshRecipientList(scope, async () => {
      const directory = await api<DirectoryEntry[]>(`directory?owner=${scope.owner}`);
      if (!directory.ok) throw new Error(directory.body.error ?? `The agent answered ${directory.status}.`);
      if (!Array.isArray(directory.body)) throw new Error("The agent returned an unreadable directory.");
      return Promise.all(directory.body.map(async (entry) => {
        const address = getAddress(entry.address);
        return { ...entry, address, onChain: await readRecipientAuthorization(scope.vault, address) };
      }));
    }, (state) => setData({ ...state, scope }));
  }, [api, scope]);

  useLayoutEffect(() => {
    scope.active = true;
    void refresh();
    return () => { scope.active = false; };
  }, [scope, refresh]);

  return { list: data?.scope === scope ? data.list : null, error: data?.scope === scope ? data.error : null, refresh };
}
