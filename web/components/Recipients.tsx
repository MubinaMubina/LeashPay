"use client";

import { Skeleton } from "./Skeleton";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { errorText, publicClient, useApi, useOwnerWallet, useSendAndWait } from "@/lib/client";
import { DEMO_RECIPIENTS } from "@/lib/demo";
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
  | { kind: "added" | "removed"; name: string }
  | { kind: "remove"; recipient: DirectoryEntry; stage: "review" | "checking" | "wallet" | "directory"; error?: string };

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
  const mutationLock = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const showList = phase.kind === "closed" || phase.kind === "added" || phase.kind === "removed";

  useEffect(() => {
    if (showList && returnFocus.current) {
      const target = document.getElementById(returnFocus.current) ?? document.getElementById("add-recipient");
      target?.focus();
      returnFocus.current = null;
    }
  }, [showList]);

  function backToList() {
    if (mutationLock.current) return;
    setForm(EMPTY);
    setPhase({ kind: "closed" });
  }

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
    if (!showList || !visible.length) return;
    let cancelled = false;
    setChecks(new Map());
    // Coalesce keystrokes before contacting the vault. Names render immediately.
    const timer = window.setTimeout(async () => {
      const entries = await Promise.all(visible.map(async ({ address }) =>
        [address, await readRecipient(vault, address)] as const));
      if (!cancelled) setChecks(new Map(entries));
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [visible, vault, showList]);

  const add = async () => {
    if (mutationLock.current) return;
    if (!owner || agent === undefined) return setPhase({ kind: "open", error: "Your vault is still loading. Try again in a moment." });
    mutationLock.current = true;
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
      setPhase({ kind: "added", name });
    } catch (err) {
      setPhase({ kind: "open", error: errorText(err) });
    } finally {
      mutationLock.current = false;
    }
  };

  const remove = async (recipient: DirectoryEntry) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setPhase({ kind: "remove", recipient, stage: "checking" });
    try {
      const status = await readRecipient(vault, recipient.address);
      if (!status) throw new Error("Couldn’t read this recipient’s vault status. Try again.");

      // Keep the cap when disabling a contact. For a zero-cap seeded contact, preserve its demo cap
      // so onboarding can distinguish an explicit removal from a never-configured address.
      const demo = DEMO_RECIPIENTS.find((entry) => entry.address.toLowerCase() === recipient.address.toLowerCase());
      const cap = status.monthlyCap || demo?.monthlyCap || 0n;
      if (status.allowed || cap !== status.monthlyCap) {
        setPhase({ kind: "remove", recipient, stage: "wallet" });
        await sendAndWait(vault, encodeFunctionData({
          abi: leashVaultAbi, functionName: "setRecipient", args: [recipient.address, false, cap],
        }));
      }

      setPhase({ kind: "remove", recipient, stage: "directory" });
      const saved = await api<DirectoryEntry[]>("directory/remove", { body: { address: recipient.address } });
      if (!saved.ok) {
        throw new Error(`Couldn’t finish removing this recipient from the directory. ${saved.body.error || "Try again."}`);
      }
      setList(saved.body);
      setLoadError(null);
      setPhase({ kind: "removed", name: recipient.name });
    } catch (err) {
      setPhase({ kind: "remove", recipient, stage: "review", error: errorText(err) });
    } finally {
      mutationLock.current = false;
    }
  };

  const busy = phase.kind === "checking" || phase.kind === "vault" || phase.kind === "directory" || (phase.kind === "remove" && phase.stage !== "review");
  const field = (key: keyof RecipientForm) => ({
    value: form[key],
    disabled: busy,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <>
      <header className="directory-head">
        {!showList && <button type="button" autoFocus={phase.kind === "remove"} className="back-to-recipients" disabled={busy}
          aria-label="Back to recipients" title="Back to recipients" onClick={backToList}>←</button>}
        <h1>{showList ? "Recipients" : phase.kind === "remove" ? "Delete recipient" : "Add recipient"}</h1>
        {showList && <button className="btn" id="add-recipient" onClick={() => {
          returnFocus.current = "add-recipient";
          setPhase({ kind: "open" });
        }}>Add recipient</button>}
      </header>
      {showList ? (
        <>
          <div className="directory-search">
            <input id="recipient-search" aria-label="Search recipients by name" type="search" placeholder="Search by name…" value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          </div>
          {loadError && <p role="alert" className="error-card">{loadError} <button className="link" onClick={load}>Retry</button></p>}
          {phase.kind === "added" && <p role="status" className="added">{phase.name} added to your recipients.</p>}
          {phase.kind === "removed" && <p role="status" className="added">{phase.name} removed from your recipients.</p>}
          {(visible.length > 0 || (list === null && !loadError)) && <div className="directory-columns">
            <span>Name</span><span>Monthly cap</span><span className="sr-only">Actions</span>
          </div>}
          <div className="directory-list" ref={scrollArea}>
            {list === null && !loadError && <Skeleton variant="recipients" label="Loading recipients" />}
            {list !== null && !matches.length && <p className="hint">{list.length ? "No matching recipients." : "No recipients yet."}</p>}
            <ul aria-label="Recipient directory">
              {visible.map((r) => {
                const check = checks.get(r.address);
                return (
                  <li key={r.address} className="person">
                    <div className="person-identity"><strong>{r.name}</strong>
                      <small>{[r.country, r.currency].filter(Boolean).join(" · ")}</small>
                    </div>
                    <div className="person-cap">{check === undefined ? <span className="cap-loading"><span className="sr-only">Checking limit…</span></span> :
                      check === null ? "Limit unavailable" : check.allowed ?
                      <>{formatAmount(check.monthlyCap.toString(), "").trim()} <small>/ 30 days</small></> :
                      <span className="not-allowed">Not in vault</span>}</div>
                    <button type="button" className="remove-recipient" id={`delete-${r.address}`}
                      aria-label={`Delete ${r.name}`} title={`Delete ${r.name}`} onClick={() => {
                        returnFocus.current = `delete-${r.address}`;
                        setPhase({ kind: "remove", recipient: r, stage: "review" });
                      }}>
                      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
                      </svg>
                    </button>
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
      ) : phase.kind === "remove" ? (
        <div className="remove-review">
          <h2>{phase.recipient.name}</h2>
          <code>{phase.recipient.address}</code>
          <p>Deleting this recipient blocks future payouts to this wallet. Past payments stay in your history.</p>
          {phase.error && <p role="alert" className="error-card">{phase.error}</p>}
          <button className="btn remove-confirm" type="button" disabled={busy} onClick={() => void remove(phase.recipient)}>
            {phase.stage === "checking" ? "Checking vault…" : phase.stage === "wallet" ? "Confirm in your wallet…" :
              phase.stage === "directory" ? "Removing…" : phase.error ? "Retry deletion" : "Delete recipient"}
          </button>
        </div>
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
          </div>
        </form>
      )}
    </>
  );
}
