"use client";

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { errorText, publicClient, useApi, useOwnerWallet, useSendAndWait } from "@/lib/client";
import { formatAmount } from "@/lib/plan-progress";
import { CURRENCIES, checkNewRecipient, type ListedRecipient, type NewRecipient, type RecipientForm } from "@/lib/recipients";

interface DirectoryEntry {
  name: string;
  address: string;
  country?: string;
  currency?: string;
}

type Phase =
  | { kind: "closed" }
  | { kind: "open"; error?: string }
  | { kind: "vault"; name: string }
  | { kind: "directory"; name: string }
  | { kind: "added"; name: string };

const EMPTY: RecipientForm = { name: "", address: "", country: "", currency: "VND", monthlyCap: "1000" };

/** The agent's address book for this owner, each entry with the vault's own view of it. */
async function readRecipients(vault: Address, directory: DirectoryEntry[]): Promise<ListedRecipient[]> {
  return Promise.all(
    directory.map(async (entry) => {
      const address = getAddress(entry.address);
      try {
        const [allowed, monthlyCap, spentThisMonth] = await publicClient.readContract({
          address: vault,
          abi: leashVaultAbi,
          functionName: "recipientInfo",
          args: [address],
        });
        return { ...entry, address, onChain: { allowed, monthlyCap, spentThisMonth } };
      } catch {
        return { ...entry, address, onChain: null };
      }
    }),
  );
}

/**
 * The owner's recipients and the form that adds one. Adding is the owner's own vault
 * transaction (setRecipient), then a directory entry so the agent knows the name. The
 * agent's key can't do the first step, which is why "send all funds to 0xBAD…" fails.
 */
/** `agent` is undefined until the vault is read, and null when the vault has no agent. */
export function Recipients({ vault, agent }: { vault: Address; agent: Address | null | undefined }) {
  const api = useApi();
  const sendAndWait = useSendAndWait();
  const owner = useOwnerWallet();
  const [list, setList] = useState<ListedRecipient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<RecipientForm>(EMPTY);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });

  const load = useCallback(async (): Promise<ListedRecipient[] | null> => {
    const directory = await api<DirectoryEntry[]>("directory");
    if (!directory.ok) {
      setLoadError(directory.body.error ?? `The agent answered ${directory.status}.`);
      return null;
    }
    const next = await readRecipients(vault, directory.body);
    setList(next);
    setLoadError(null);
    return next;
  }, [api, vault]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (!owner) return setPhase({ kind: "open", error: "Your wallet isn't ready yet." });
    // Without the agent's address the "agent can't pay itself" check can't run.
    if (agent === undefined) return setPhase({ kind: "open", error: "Still reading your vault. Try again in a moment." });
    // Checked against a fresh list, so a name or address added in another tab still counts.
    const current = (await load()) ?? list ?? [];
    const checked = checkNewRecipient(form, current, { owner: getAddress(owner.address), vault, agent });
    if (!checked.ok) return setPhase({ kind: "open", error: checked.error });
    const recipient: NewRecipient = checked.recipient;
    try {
      setPhase({ kind: "vault", name: recipient.name });
      await sendAndWait(
        vault,
        encodeFunctionData({ abi: leashVaultAbi, functionName: "setRecipient", args: [recipient.address, true, recipient.monthlyCap] }),
      );
      setPhase({ kind: "directory", name: recipient.name });
      const { name, address, country, currency } = recipient;
      const saved = await api("directory", { body: { name, address, ...(country ? { country } : {}), currency } });
      if (!saved.ok) {
        throw new Error(
          `${name} is allowed in the vault, but the agent didn't save the name (${saved.body.error ?? saved.status}). Submit again to finish.`,
        );
      }
      await load();
      setForm(EMPTY);
      setPhase({ kind: "added", name });
    } catch (err) {
      await load();
      setPhase({ kind: "open", error: errorText(err) });
    }
  }, [owner, load, list, form, vault, agent, sendAndWait, api]);

  const busy = phase.kind === "vault" || phase.kind === "directory";
  const field = (key: keyof RecipientForm) => ({
    value: form[key],
    disabled: busy,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <>
      <div className="label">Recipients</div>
      {loadError && <div className="sub">{loadError}</div>}
      {list === null && !loadError && <div className="sub">…</div>}
      {list?.length === 0 && <div className="sub">No recipients yet.</div>}
      {list?.map((r) => (
        <div className="person" key={r.address}>
          <span>
            {r.name} {r.country && <small>· {r.country}</small>}
          </span>
          {r.onChain === null ? (
            <small>vault unreadable</small>
          ) : r.onChain.allowed ? (
            <small>{formatAmount(r.onChain.monthlyCap.toString(), "").trim()} / 30 days</small>
          ) : (
            <small className="not-allowed" title="Add this address again to finish: the vault would refuse a payment now.">
              not in vault
            </small>
          )}
        </div>
      ))}

      {phase.kind === "added" && (
        <div className="added">
          {phase.name} can be paid now. Try “Pay {phase.name} 1”.
        </div>
      )}

      {phase.kind === "closed" || phase.kind === "added" ? (
        <button className="link add-link" onClick={() => setPhase({ kind: "open" })}>
          + Add recipient
        </button>
      ) : (
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>
            Name
            <input {...field("name")} placeholder="Ramon" maxLength={60} autoFocus />
          </label>
          <label>
            Wallet address
            <input {...field("address")} placeholder="0x…" spellCheck={false} autoComplete="off" />
          </label>
          <div className="add-row">
            <label>
              Country
              <input {...field("country")} placeholder="PH" maxLength={60} />
            </label>
            <label>
              Currency
              <select {...field("currency")}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Monthly cap (USDT or USDC per 30 days)
            <input {...field("monthlyCap")} inputMode="decimal" />
          </label>
          <p className="sub">Your wallet signs this: the agent can't add anyone to your vault.</p>
          {phase.kind === "open" && phase.error && <p className="kill-error">{phase.error}</p>}
          <div className="add-actions">
            <button className="btn" type="submit" disabled={busy}>
              {phase.kind === "vault"
                ? "Confirm in your wallet…"
                : phase.kind === "directory"
                  ? "Saving the name…"
                  : "Add recipient"}
            </button>
            <button className="link" type="button" disabled={busy} onClick={() => setPhase({ kind: "closed" })}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
}
