import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { getAddress, isAddressEqual, parseEventLogs, type Address, type TransactionReceipt } from "viem";
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

export async function readRecipientAuthorization(vault: Address, recipient: Address, blockNumber?: bigint): Promise<ListedRecipient["onChain"]> {
  try {
    const [allowed, monthlyCap, spentThisMonth] = await publicClient.readContract({
      address: vault, abi: leashVaultAbi, functionName: "recipientInfo", args: [recipient], blockNumber,
    });
    return { allowed, monthlyCap, spentThisMonth };
  } catch {
    return null;
  }
}

/** Only the owner can change this rule. Pin the owner's nonce to the same block as
 * the allowance read, so a later confirmed revocation makes this transaction stale. */
export async function readCapForEdit(vault: Address, recipient: Address, owner: Address) {
  const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
  const [authorization, nonce, pending] = await Promise.all([
    readRecipientAuthorization(vault, recipient, blockNumber),
    publicClient.getTransactionCount({ address: owner, blockNumber }),
    publicClient.getTransactionCount({ address: owner, blockTag: "pending" }),
  ]);
  if (pending !== nonce) throw new Error("Your wallet has another transaction in progress. Wait for it to confirm and try again.");
  return { authorization, nonce };
}

export function verifyCapReceipt(receipt: Pick<TransactionReceipt, "logs">, vault: Address, recipient: Address, cap: bigint) {
  const updates = parseEventLogs({ abi: leashVaultAbi, eventName: "RecipientUpdated", logs: receipt.logs });
  if (!updates.some(log => isAddressEqual(log.address, vault) && isAddressEqual(log.args.recipient, recipient) &&
    log.args.allowed && log.args.monthlyCap === cap)) {
    throw new Error("The transaction receipt didn’t confirm this cap. Reopen the recipient to check the current limit.");
  }
}

export function useRecipientBook(vault: Address | null): RecipientBook {
  const api = useApi();
  const owner = useOwnerWallet()?.address;
  // Responses from an earlier owner, vault, or overlapping refresh cannot replace the current list.
  const scope = useMemo(() => ({ owner, vault, active: true, request: 0, previewRequested: false }), [owner, vault]);
  const [data, setData] = useState<BookData & { scope: typeof scope } | null>(null);
  const [revision, setRevision] = useState(0);
  const readDirectory = useCallback(async () => {
    if (!scope.active || !scope.owner || !scope.vault) throw new Error("Your wallet isn't ready yet.");
    const directory = await api<DirectoryEntry[]>(`directory?owner=${scope.owner}`);
    if (!scope.active) throw new Error("Your wallet session changed.");
    if (!directory.ok) throw new Error(directory.body.error ?? `The agent answered ${directory.status}.`);
    if (!Array.isArray(directory.body)) throw new Error("The agent returned an unreadable directory.");
    return directory.body;
  }, [api, scope]);
  const refresh = useCallback(() => {
    const currentVault = scope.vault;
    if (!currentVault) return Promise.resolve(null);
    scope.previewRequested = true;
    return refreshRecipientList(scope, async () => {
      const directory = await readDirectory();
      return Promise.all(directory.map(async (entry) => {
        const address = getAddress(entry.address);
        return { ...entry, address, onChain: await readRecipientAuthorization(currentVault, address) };
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
