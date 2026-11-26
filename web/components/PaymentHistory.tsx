"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { explorerTx, shortAddress } from "@/lib/chain";
import { formatTokenAmount } from "@/lib/plan-progress";
import { useApi } from "@/lib/client";
import type { HistoryFilter, HistoryPage } from "@/lib/payment-history";
import type { RecipientBook } from "@/lib/recipient-book";
import type { DirectoryEntry } from "@/lib/recipients";
import { Skeleton } from "./Skeleton";

const directions = { all: "All", sent: "Sent", received: "Received" } as const;
const coins = ["USDT", "USDC"] as const;
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function PaymentHistory({ book, vault }: { book: RecipientBook; vault: Address | null }) {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [refresh, setRefresh] = useState(0);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const { readDirectory, revision } = book;
  useEffect(() => {
    if (!vault) return;
    let current = true;
    void readDirectory().then(entries => { if (current) setDirectory(entries); }).catch(() => {});
    return () => { current = false; };
  }, [vault, readDirectory, revision]);
  return <>
    <div className="history-toolbar">
      <div className="history-filters" role="group" aria-label="Payment direction">
        {(Object.keys(directions) as HistoryFilter[]).map(key =>
          <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{directions[key]}</button>)}
      </div>
      <button type="button" className="link history-refresh" onClick={() => setRefresh(n => n + 1)}>Refresh</button>
    </div>
    <PaymentList key={`${filter}:${refresh}`} filter={filter} directory={directory} fresh />
  </>;
}

export function PaymentList({ filter = "all", directory = [], contact, fresh = false }: {
  filter?: HistoryFilter; directory?: DirectoryEntry[]; contact?: DirectoryEntry; fresh?: boolean;
}) {
  const api = useApi();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const address = contact?.address;
  const feed = useRef<HTMLDivElement>(null);
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    const index = focusRow.current;
    if (index !== null && page && page.payments.length > index) {
      if (document.activeElement === document.body || feed.current?.querySelector(".history-more") === document.activeElement) {
        feed.current?.querySelectorAll<HTMLAnchorElement>(".payment-receipt a")[index]?.focus();
      }
      focusRow.current = null;
    }
  }, [page]);
  useEffect(() => {
    let current = true;
    const params = new URLSearchParams({ filter });
    if (address) params.set("contact", address);
    if (before) params.set("before", before);
    else if (fresh) params.set("fresh", "1");
    void api<HistoryPage>(`history?${params}`).then(result => {
      if (!current) return;
      if (result.ok && Array.isArray(result.body.payments)) {
        const next = result.body;
        setPage(old => {
          if (!before || !old) return next;
          const seen = new Set(old.payments.map(p => `${p.hash}:${p.logIndex}`));
          return { ...next, payments: [...old.payments, ...next.payments.filter(p => !seen.has(`${p.hash}:${p.logIndex}`))] };
        });
      } else {
        setError(result.body.error || "Couldn’t load your payment history.");
      }
      setLoading(false);
    });
    return () => { current = false; };
  }, [api, address, filter, before, attempt, fresh]);

  const names = new Map(directory.map(entry => [entry.address.toLowerCase(), entry.name]));
  return <div className="payment-feed" ref={feed}>
    {contact && page && <>
      <div className="history-totals">
        {(["sent", "received"] as const).map(dir => <div key={dir}>
          <h3>{dir === "sent" ? "Total sent" : "Total received"}</h3>
          {coins.map(coin => <div key={coin}><strong>{formatTokenAmount(page.totals[dir][coin])}</strong> {coin}</div>)}
        </div>)}
      </div>
      <h3 className="activity-title">Payment activity</h3>
    </>}
    {!page && loading && <Skeleton variant="history" label="Loading confirmed payments" />}
    {page && !page.payments.length && <p className="history-empty">
      {contact ? `No confirmed payments with ${contact.name} yet.` : filter === "sent" ? "You haven’t sent any LeashPay payments yet."
        : filter === "received" ? "You haven’t received any LeashPay payments yet." : "No confirmed LeashPay payments yet."}
    </p>}
    {page && page.payments.length > 0 && <ul className="payment-rows" aria-label="Confirmed payments">
      {page.payments.map(p => {
        const name = contact?.name ?? names.get(p.address.toLowerCase()) ?? names.get(p.wallet.toLowerCase())
          ?? (p.vault && names.get(p.vault.toLowerCase())) ?? shortAddress(p.wallet);
        const label = p.direction === "self" ? "To yourself" : p.direction === "sent" ? `To ${name}` : `From ${name}`;
        const date = p.timestamp === null ? null : new Date(p.timestamp * 1000);
        return <li key={`${p.hash}:${p.logIndex}`} className="payment-row">
          <span aria-hidden="true" className={`payment-arrow ${p.direction}`}>{p.direction === "received" ? "↙" : p.direction === "sent" ? "↗" : "↔"}</span>
          <div className="payment-party"><strong>{label}</strong><small>{date ?
            <time dateTime={date.toISOString()}>{timestamp.format(date)}</time> : `Block ${p.block}`}</small></div>
          <div className="payment-receipt"><strong>{p.direction === "sent" ? "−" : p.direction === "received" ? "+" : ""}{formatTokenAmount(p.amount)} {p.symbol}</strong>
            {p.fee && <small>{formatTokenAmount(p.fee.amount)} {p.fee.symbol} fee</small>}
            <a href={explorerTx(p.hash)} target="_blank" rel="noreferrer" aria-label={`BscScan receipt for ${label}, ${formatTokenAmount(p.amount)} ${p.symbol}`}>Receipt ↗</a></div>
        </li>;
      })}
    </ul>}
    {error && <div className="error-card" role="alert">{error} <button type="button" className="link" onClick={() => {
      setLoading(true); setError(""); setAttempt(n => n + 1);
    }}>Retry</button></div>}
    <span role="status" className="sr-only">{page && `Showing ${page.payments.length} of ${page.count} confirmed payments.`}</span>
    {page?.next && !error && <button type="button" className="history-more" disabled={loading} onClick={() => {
      focusRow.current = page.payments.length; setLoading(true); setBefore(page.next);
    }}>{loading ? "Loading…" : "Load 10 more"}</button>}
  </div>;
}
