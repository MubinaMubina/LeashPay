import { useEffect, useId, useState, type ReactNode } from "react";
import { shortAddress } from "@/lib/chain";
import { parseVaultBalances, recipientPage, type VaultBalances } from "@/lib/chat-cards";
import { useApi } from "@/lib/client";
import { formatAmount } from "@/lib/plan-progress";
import type { RecipientBook } from "@/lib/recipient-book";
import { Skeleton } from "./Skeleton";
import styles from "./ChatCards.module.css";

export function ChatCard({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="card plan" aria-labelledby={id}>
      <header className={styles.header}>
        <h3 id={id}>{title}</h3>
        {detail && <span className={styles.count} aria-live="polite">{detail}</span>}
      </header>
      {children}
    </section>
  );
}

const actions = [
  ["balance", "Check vault balance"],
  ["recipients", "List recipients"],
  ["add", "Add a recipient"],
  ["payment", "Prepare a payment"],
] as const;

export type HelpAction = (typeof actions)[number][0];

export function HelpCard({ onAction }: { onAction: (action: HelpAction) => void }) {
  return (
    <ChatCard title="How can I help?">
      <div className={styles.choices}>
        {actions.map(([action, label]) => (
          <button className={styles.choice} type="button" key={action} onClick={() => onAction(action)}>
            {label}<span className={styles.chevron} aria-hidden="true" />
          </button>
        ))}
      </div>
    </ChatCard>
  );
}

function ReadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.readFailure}>
      <p role="status">{message}</p>
      <button className="chip" type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

export function BalanceCard() {
  const api = useApi();
  const [attempt, setAttempt] = useState(0);
  const [balances, setBalances] = useState<VaultBalances | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setBalances(undefined);
    void (async () => {
      try {
        const result = await api<{ balances?: unknown }>("vault");
        if (current) setBalances(result.ok ? parseVaultBalances(result.body?.balances) : null);
      } catch {
        if (current) setBalances(null);
      }
    })();
    return () => { current = false; };
  }, [api, attempt]);

  return (
    <ChatCard title="Vault balance">
      {balances === undefined ? (
        <Skeleton label="Reading your vault" />
      ) : balances === null ? (
        <ReadFailure message="Couldn’t read your vault balance." onRetry={() => setAttempt((count) => count + 1)} />
      ) : (
        <dl className={`balances ${styles.balances}`}>
          {(["USDT", "USDC"] as const).map((token) => (
            <div className="kv" key={token}>
              <dt>{token}</dt>
              <dd>{formatAmount(balances[token], "").trim()}</dd>
            </div>
          ))}
          <div className={`kv ${styles.tbills}`}>
            <dt>Held in T-bills</dt>
            <dd>{formatAmount(balances.tbillValue, "USDT")}</dd>
          </div>
        </dl>
      )}
    </ChatCard>
  );
}

export function RecipientPreviewCard({ book, onViewAll, onAdd }: { book: RecipientBook; onViewAll: () => void; onAdd: () => void }) {
  const { list, error, refresh } = book;
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<"loading" | "done" | "failed">("loading");

  useEffect(() => {
    let current = true;
    setRead("loading");
    void refresh().then(
      () => { if (current) setRead("done"); },
      () => { if (current) setRead("failed"); },
    );
    return () => { current = false; };
  }, [refresh, attempt]);

  const preview = read === "done" && !error && list ? recipientPage(list, page) : null;
  const hasPages = preview && (preview.page > 0 || preview.hasNext);
  let count;
  if (preview && (preview.total > 0 || !preview.unverified)) {
    count = hasPages ? `${preview.first}–${preview.last} of ${preview.total}` : `${preview.total} recipient${preview.total === 1 ? "" : "s"}`;
    if (preview.unverified) count += " verified";
  }
  const retry = () => setAttempt((count) => count + 1);
  return (
    <ChatCard title="Who you can pay" detail={count}>
      {read === "loading" && <Skeleton label="Checking your recipients" />}
      {read !== "loading" && !preview && <ReadFailure message="Couldn’t read your recipients." onRetry={retry} />}
      {preview && (
        <>
          {preview.rows.length > 0 ? (
            <table className={styles.recipients}>
              <thead><tr><th scope="col">Recipient</th><th scope="col">30-day cap <span>(USDT or USDC)</span></th></tr></thead>
              <tbody>
                {preview.rows.map(({ name, address, cap }) => (
                  <tr key={address}>
                    <td><span className={styles.name}>{name}</span><small title={address}>{shortAddress(address)}</small></td>
                    <td>{formatAmount(cap.toString(), "").trim()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : !preview.unverified && (
            <p className={styles.status}>{list?.length ? "No named recipients are currently allowed." : "Your recipient directory is empty."}</p>
          )}
          {preview.unverified && <ReadFailure message="Couldn’t verify vault access for some recipients." onRetry={retry} />}
        </>
      )}
      <footer className={styles.footer}>
        {preview?.total === 0 && !preview.unverified && <button className="btn" type="button" onClick={onAdd}>Add a recipient</button>}
        <button className={preview?.total === 0 && !preview.unverified ? "chip" : "btn"} type="button" onClick={onViewAll}>View all recipients</button>
        {preview && hasPages && (
          <div className={styles.pager} role="group" aria-label="Recipient pages">
            <button className="chip" type="button" disabled={preview.page === 0} onClick={() => setPage(preview.page - 1)}>Previous</button>
            <button className="chip" type="button" disabled={!preview.hasNext} onClick={() => setPage(preview.page + 1)}>Next</button>
          </div>
        )}
      </footer>
    </ChatCard>
  );
}
