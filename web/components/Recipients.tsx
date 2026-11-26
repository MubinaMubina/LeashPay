"use client";

import { Skeleton } from "./Skeleton";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encodeFunctionData, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { errorText, useApi, useOwnerWallet, useSendAndWait } from "@/lib/client";
import { formatTokenAmount } from "@/lib/plan-progress";
import { RecipientDetails } from "./RecipientDetails";
import { AddRecipientForm } from "./RecipientForm";
import { readRecipientAuthorization, withVaultLock, type RecipientBook } from "@/lib/recipient-book";
import type { DirectoryEntry, ListedRecipient } from "@/lib/recipients";

const PAGE_SIZE = 10;

type Phase =
  | { kind: "closed" }
  | { kind: "open" }
  | { kind: "added" | "removed"; name: string }
  | { kind: "remove"; recipient: DirectoryEntry; stage: "review" | "checking" | "wallet" | "directory"; error?: string };

export function Recipients({ vault, agent, book, listRequest, accessNotice }: { vault: Address | null; accessNotice: ReactNode; agent: Address | null | undefined; book: RecipientBook; listRequest: number }) {
  const api = useApi();
  const sendAndWait = useSendAndWait();
  const owner = useOwnerWallet();
  const [list, setList] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const previousRequest = useRef(listRequest);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [selected, setSelected] = useState<DirectoryEntry | null>(null);
  const contact = selected && (list?.find(entry => entry.address === selected.address) ?? selected);
  const [walletPending, setWalletPending] = useState(false);
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

  useEffect(() => {
    if (previousRequest.current === listRequest) return;
    previousRequest.current = listRequest;
    setQuery("");
    setPage(0);
    if (!adding && !mutationLock.current) {
      returnFocus.current = null;
      setPhase({ kind: "closed" });
    }
  }, [listRequest, adding]);

  function backToList() {
    if (adding || mutationLock.current) return;
    setPhase({ kind: "closed" });
  }

  const [attempt, setAttempt] = useState(0);
  const { readDirectory, revision } = book;
  useEffect(() => {
    if (!vault) return;
    let current = true;
    void readDirectory().then(entries => {
      if (current) { setList(entries); setLoadError(null); }
    }).catch(err => {
      if (current) { setList(null); setLoadError(errorText(err)); }
    });
    return () => { current = false; };
  }, [readDirectory, revision, attempt, vault]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (list ?? []).filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [list, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const visible = useMemo(() => matches.slice(start, start + PAGE_SIZE), [matches, start]);

  useEffect(() => {
    scrollArea.current?.scrollTo({ top: 0 });
    if (!vault || !showList || !visible.length) return;
    let cancelled = false;
    setChecks(new Map());
    // Coalesce keystrokes before contacting the vault. Names render immediately.
    const timer = window.setTimeout(async () => {
      const entries = await Promise.all(visible.map(async ({ address }) =>
        [address, await readRecipientAuthorization(vault, address)] as const));
      if (!cancelled) setChecks(new Map(entries));
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [visible, vault, showList]);

  const remove = async (recipient: DirectoryEntry) => {
    if (!vault || mutationLock.current) return;
    if (!owner) {
      setPhase({ kind: "remove", recipient, stage: "review", error: "Your wallet isn't ready yet." });
      return;
    }
    mutationLock.current = true;
    setPhase({ kind: "remove", recipient, stage: "checking" });
    try {
      await withVaultLock(vault, async () => {
        const status = await readRecipientAuthorization(vault, recipient.address);
        if (!status) throw new Error("Couldn’t read this recipient’s vault status. Try again.");

        if (status.allowed) {
          setPhase({ kind: "remove", recipient, stage: "wallet" });
          await sendAndWait(vault, encodeFunctionData({
            abi: leashVaultAbi, functionName: "setRecipient", args: [recipient.address, false, status.monthlyCap],
          }));
        }

        setPhase({ kind: "remove", recipient, stage: "directory" });
        const saved = await api<DirectoryEntry[]>("directory/remove", { body: { address: recipient.address, owner: owner.address } });
        if (!saved.ok) {
          throw new Error(`Couldn’t finish removing this recipient from the directory. ${saved.body.error || "Try again."}`);
        }
        setList(saved.body);
      });
      setLoadError(null);
      setPhase({ kind: "removed", name: recipient.name });
    } catch (err) {
      setPhase({ kind: "remove", recipient, stage: "review", error: errorText(err) });
    } finally {
      book.changed();
      mutationLock.current = false;
    }
  };

  const busy = adding || (phase.kind === "remove" && phase.stage !== "review");

  const details = contact && vault && <RecipientDetails key={contact.address} contact={contact} book={book} vault={vault}
    onDirectory={entries => {
      setList(entries);
      setSelected(entries.find(entry => entry.address === contact.address) ?? null);
      setLoadError(null);
    }} onWalletPending={setWalletPending} onClose={() => {
      setSelected(null);
      setWalletPending(false);
      requestAnimationFrame(() => {
        const target = document.getElementById(`details-${contact.address}`) ?? document.getElementById("recipient-search");
        if (target && !target.closest("[hidden]")) target.focus();
      });
    }} />;

  if (walletPending) return <>{details}<div className="directory-head" role="status">
    Waiting for wallet confirmation and the transaction receipt…
  </div></>;

  return (
    <>
      {details}
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
          {loadError && <p role="alert" className="error-card">{loadError} <button className="link" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>}
          {phase.kind === "added" && <p role="status" className="added">{phase.name} added to your recipients.</p>}
          {phase.kind === "removed" && <p role="status" className="added">{phase.name} removed from your recipients.</p>}
          {vault && (visible.length > 0 || (list === null && !loadError)) && <div className="directory-columns">
            <span>Name</span><span>Monthly cap</span><span className="sr-only">Actions</span>
          </div>}
          <div className="directory-list" ref={scrollArea}>
            {!vault && <p className="hint">Your recipients will appear here.</p>}
            {vault && list === null && !loadError && <Skeleton variant="recipients" label="Loading recipients" />}
            {list !== null && !matches.length && <p className="hint">{list.length ? "No matching recipients." : "No recipients yet."}</p>}
            <ul aria-label="Recipient directory">
              {visible.map((r) => {
                const check = checks.get(r.address);
                return (
                  <li key={r.address} className="person">
                    <button type="button" className="person-details" id={`details-${r.address}`} aria-haspopup="dialog" aria-label={`View details for ${r.name}`}
                      onClick={() => setSelected(r)}>
                    <span className="person-identity"><strong>{r.name}</strong>
                      <small>{[r.country, r.currency].filter(Boolean).join(" · ")}</small>
                    </span>
                    <span className="person-cap">{check === undefined ? <span className="cap-loading"><span className="sr-only">Checking limit…</span></span> :
                      check === null ? "Limit unavailable" : check.allowed ?
                      <>{formatTokenAmount(check.monthlyCap.toString())} <small>/ 30 days</small></> :
                      <span className="not-allowed">Not in vault</span>}</span>
                    </button>
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
      ) : !vault ? <div className="directory-access">{accessNotice}</div> : (
        <AddRecipientForm vault={vault} agent={agent} book={book} onBusyChange={setAdding} onCancel={backToList}
          onAdded={(name) => setPhase({ kind: "added", name })} />
      )}
    </>
  );
}
