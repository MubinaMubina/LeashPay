import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";
import { leashVaultAbi } from "./abi.generated";
import { errorText, publicClient, useApi, useOwnerWallet } from "./client";
import type { DirectoryEntry, ListedRecipient } from "./recipients";

export interface RecipientBook {
  list: ListedRecipient[] | null;
  error: string | null;
  readDirectory: () => Promise<DirectoryEntry[]>;
  revision: number;
  changed: () => void;
  refresh: () => Promise<ListedRecipient[] | null>;
}

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
  const scope = useMemo(() => ({ owner, vault, active: true, request: 0, previewRequested: false }), [owner, vault]);
  const [data, setData] = useState<BookData & { scope: typeof scope } | null>(null);
  const [revision, setRevision] = useState(0);
  const readDirectory = useCallback(async () => {
    if (!scope.active || !scope.owner) throw new Error("Your wallet isn't ready yet.");
    const directory = await api<DirectoryEntry[]>(`directory?owner=${scope.owner}`);
    if (!scope.active) throw new Error("Your wallet session changed.");
    if (!directory.ok) throw new Error(directory.body.error ?? `The agent answered ${directory.status}.`);
    if (!Array.isArray(directory.body)) throw new Error("The agent returned an unreadable directory.");
    return directory.body;
  }, [api, scope]);
  const refresh = useCallback(() => {
    scope.previewRequested = true;
    return refreshRecipientList(scope, async () => {
      const directory = await readDirectory();
      return Promise.all(directory.map(async (entry) => {
        const address = getAddress(entry.address);
        return { ...entry, address, onChain: await readRecipientAuthorization(scope.vault, address) };
      }));
    }, (state) => setData({ ...state, scope }));
  }, [readDirectory, scope]);
  const changed = useCallback(() => {
    if (!scope.active) return;
    setRevision(n => n + 1);
    if (scope.previewRequested) void refresh();
  }, [refresh, scope]);

  useLayoutEffect(() => {
    scope.active = true;
    return () => { scope.active = false; };
  }, [scope]);

  return { list: data?.scope === scope ? data.list : null, error: data?.scope === scope ? data.error : null,
    readDirectory, revision, changed, refresh };
}

const pendingVaults = new Set<string>();

/** Hold the lock through confirmation and the directory save. Web Locks also cover other tabs. */
export async function withVaultLock<T>(vault: Address, action: () => Promise<T>): Promise<T> {
  const key = `leashpay.recipient.${vault.toLowerCase()}`;
  const busy = "Another recipient change is in progress for this vault. Try again once it finishes.";
  if (navigator.locks) {
    return navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error(busy);
      return action();
    });
  }
  if (pendingVaults.has(key)) throw new Error(busy);
  pendingVaults.add(key);
  try {
    return await action();
  } finally {
    pendingVaults.delete(key);
  }
}
