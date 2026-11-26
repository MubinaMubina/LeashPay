"use client";

import { Skeleton } from "./Skeleton";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { errorText, publicClient, useApi, useOwnerWallet, useSendAndWait } from "@/lib/client";
import { formatAmount } from "@/lib/plan-progress";
import { CURRENCIES, checkNewRecipient, type ListedRecipient, type NewRecipient, type RecipientForm } from "@/lib/recipients";

type DirectoryEntry = Omit<ListedRecipient, "onChain">;
const PAGE_SIZE = 10;
// Matches MAX_RECIPIENTS in agent/src/plan/directory.ts.
const DIRECTORY_LIMIT = 200;

type Phase =
  | { kind: "closed" }
  | { kind: "open"; error?: string }
  | { kind: "checking" }
  | { kind: "vault"; name: string }
  | { kind: "directory"; name: string }
  | { kind: "added"; name: string };

const EMPTY: RecipientForm = { name: "", address: "", country: "", currency: "VND", monthlyCap: "1000" };

async function readRecipient(vault: Address, address: Address): Promise<ListedRecipient["onChain"]> {
  try {
    const [allowed, monthlyCap, spentThisMonth] = await publicClient.readContract({
      address: vault, abi: leashVaultAbi, functionName: "recipientInfo", args: [address],
    });
    return { allowed, monthlyCap, spentThisMonth };
  } catch {
    return null;
  }
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
  const [list, setList] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<RecipientForm>(EMPTY);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [checks, setChecks] = useState(new Map<Address, ListedRecipient["onChain"]>());
  const scrollArea = useRef<HTMLDivElement>(null);
  const addLock = useRef(false);
  const showForm = phase.kind !== "closed" && phase.kind !== "added";

  const load = useCallback(async () => {
    const directory = await api<DirectoryEntry[]>("directory");
    if (!directory.ok) {
      setLoadError(directory.body.error ?? "Couldn’t load recipients.");
      return null;
    }
    setList(directory.body);
    setLoadError(null);
    return directory.body;
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (list ?? []).filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [list, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const visible = useMemo(() => matches.slice(start, start + PAGE_SIZE), [matches, start]);

  useEffect(() => {
    scrollArea.current?.scrollTo({ top: 0 });
    if (showForm || !visible.length) return;
    let cancelled = false;
    setChecks(new Map());
    // Coalesce keystrokes before contacting the vault. Names render immediately.
    const timer = window.setTimeout(async () => {
      const entries = await Promise.all(visible.map(async ({ address }) =>
        [address, await readRecipient(vault, address)] as const));
      if (!cancelled) setChecks(new Map(entries));
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [visible, vault, showForm]);

  const add = async () => {
    if (addLock.current) return;
    if (!owner || agent === undefined) return setPhase({ kind: "open", error: "Your vault is still loading. Try again in a moment." });
    addLock.current = true;
    setPhase({ kind: "checking" });
    try {
      const current = await load();
      if (!current) throw new Error("Couldn’t verify the directory. Try again.");
      // Duplicate names must be checked across every page. Only a matching address needs a fresh chain read.
      const duplicate = current.find((r) => r.address.toLowerCase() === form.address.trim().toLowerCase());
      const onChain = duplicate ? await readRecipient(vault, duplicate.address) : null;
      if (duplicate && !onChain) throw new Error("Couldn’t verify this wallet’s current limit. Try again.");
      const existing = current.map((r) => ({ ...r, onChain: r === duplicate ? onChain : null }));
      const checked = checkNewRecipient(form, existing, { owner: getAddress(owner.address), vault, agent });
      if (!checked.ok) throw new Error(checked.error);
      if (!duplicate && current.length >= DIRECTORY_LIMIT) {
        throw new Error(`Your directory has reached its ${DIRECTORY_LIMIT}-recipient limit.`);
      }
      const recipient: NewRecipient = checked.recipient;
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
      setQuery(name);
      setPage(0);
      setPhase({ kind: "added", name });
    } catch (err) {
      setPhase({ kind: "open", error: errorText(err) });
    } finally {
      addLock.current = false;
    }
  };

  const busy = phase.kind === "checking" || phase.kind === "vault" || phase.kind === "directory";
  const field = (key: keyof RecipientForm) => ({
    value: form[key],
    disabled: busy,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <>
      <header className="directory-head">
        <h1>{showForm ? "Add recipient" : "Recipients"}</h1>
        {!showForm && <button className="btn" onClick={() => setPhase({ kind: "open" })}>Add recipient</button>}
      </header>
      {!showForm ? (
        <>
          <div className="directory-search">
            <input aria-label="Search recipients by name" type="search" placeholder="Search by name…" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          </div>
          {loadError && <p role="alert" className="error-card">{loadError} <button className="link" onClick={load}>Retry</button></p>}
          {phase.kind === "added" && <p role="status" className="added">{phase.name} added to your recipients.</p>}
          {visible.length > 0 && <div className="directory-columns"><span>Name</span><span>Monthly cap</span></div>}
          <div className="directory-list" ref={scrollArea}>
            {list === null && !loadError && <Skeleton label="Loading recipients" />}
            {list !== null && !matches.length && <p className="hint">{list.length ? "No matching recipients." : "No recipients yet."}</p>}
            <ul aria-label="Recipient directory">
              {visible.map((r) => {
                const check = checks.get(r.address);
                return (
                  <li key={r.address} className="person">
                    <div className="person-identity"><strong>{r.name}</strong>
                      <small>{[r.country, r.currency].filter(Boolean).join(" · ")}</small>
                    </div>
                    <div className="person-cap">{check === undefined ? "Checking limit…" :
                      check === null ? "Limit unavailable" : check.allowed ?
                      <>{formatAmount(check.monthlyCap.toString(), "").trim()} <small>/ 30 days</small></> :
                      <span className="not-allowed">Not in vault</span>}</div>
                  </li>
                );
              })}
            </ul>
          </div>
          {list !== null && <footer className="directory-footer">
            <span role="status">{matches.length ? `${start + 1}–${start + visible.length} of ${matches.length}` : "0 results"}</span>
            {matches.length > PAGE_SIZE && <div>
              <button className="chip" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
              <button className="chip" disabled={start + PAGE_SIZE >= matches.length} onClick={() => setPage(currentPage + 1)}>Next</button>
            </div>}
          </footer>}
        </>
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
              {phase.kind === "checking" ? "Checking…" : phase.kind === "vault"
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
