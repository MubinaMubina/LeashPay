"use client";

import { useSignMessage } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { explorerTx, shortAddress } from "@/lib/chain";
import { DEMO_ATTACK_ADDRESS } from "@/lib/demo";
import { DepegBox } from "./DepegBox";
import { MemoryBox } from "./MemoryBox";
import { readingTime } from "@/lib/depeg";
import { RefusalCard, type AttackResultJson } from "./RefusalCard";
import { errorText, useApi, useOwnerWallet } from "@/lib/client";
import {
  formatAmount,
  formatLocal,
  isExecutable,
  localQuotedAt,
  needsCheckAgain,
  rowStatus,
  type JournalEventJson,
  type PaymentResultJson,
  type PlanJson,
} from "@/lib/plan-progress";

/** Keep the chat excerpt short; the detail sheet retains the original text. */
function excerpt(text: string) {
  return text.length > 110 ? text.slice(0, 107).trimEnd() + "…" : text;
}

type Attack =
  | { stage: "idle" }
  | { stage: "sending" }
  | { stage: "done"; result: AttackResultJson }
  | { stage: "failed"; error: string };

type Run =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "running" }
  | { kind: "busy" }
  | { kind: "failed"; error: string };

/**
 * One plan: each payment with the vault's verdict, then "Approve with wallet". The card
 * turns into the receipt in place. Retry and Check again always fetch a fresh approval and
 * run the same plan id (D16): the agent settles or skips what already went through, so
 * nothing is paid twice.
 */
export function PlanCard({
  plan,
  initialEvents,
  onSettled,
  onAgentDown,
}: {
  plan: PlanJson;
  initialEvents: JournalEventJson[];
  /** Called when a run or the demo attack ends; `attackRefused` lets the vault column show "unchanged". */
  onSettled: (outcome?: { attackRefused?: boolean }) => void;
  onAgentDown: () => void;
}) {
  const checksDialog = useRef<HTMLDialogElement>(null);
  const api = useApi();
  const owner = useOwnerWallet();
  const { signMessage } = useSignMessage();
  const [events, setEvents] = useState(initialEvents);
  const [results, setResults] = useState<PaymentResultJson[] | undefined>();
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [attack, setAttack] = useState<Attack>({ stage: "idle" });
  // The guard's own sentence is shown inside the depeg box, not again in the notes list.
  const depegNote = plan.depeg?.note;
  const notes = depegNote ? plan.notes.filter((n) => n !== depegNote) : plan.notes;

  const refreshEvents = useCallback(async () => {
    const latest = await api<{ events: JournalEventJson[] }>(`plans/${plan.id}`);
    if (latest.ok) setEvents(latest.body.events);
  }, [api, plan.id]);

  useEffect(() => {
    if (run.kind !== "running") return;
    const tick = setInterval(() => {
      setNow(Date.now());
      void refreshEvents();
    }, 1000);
    return () => clearInterval(tick);
  }, [run.kind, refreshEvents]);

  const approve = useCallback(async () => {
    if (!owner) return;
    setRun({ kind: "signing" });
    const approval = await api<{ message: string; expires: string; payEarly: boolean }>(`plans/${plan.id}/approval`);
    if (!approval.ok) {
      if (approval.status === 502) onAgentDown();
      setRun({ kind: "failed", error: approval.body.error ?? `The agent answered ${approval.status}.` });
      return;
    }
    let signature: string;
    try {
      ({ signature } = await signMessage({ message: approval.body.message }, { address: owner.address }));
    } catch (err) {
      setRun({ kind: "failed", error: `Not signed: ${errorText(err)}` });
      return;
    }
    setRun({ kind: "running" });
    const { expires, payEarly } = approval.body;
    const outcome = await api<{ results: PaymentResultJson[] }>(`plans/${plan.id}/execute`, { body: { expires, signature, payEarly } });
    await refreshEvents();
    setNow(Date.now());
    if (outcome.ok) {
      setResults(outcome.body.results);
      setRun({ kind: "idle" });
      onSettled();
    } else if (outcome.status === 409) {
      setRun({ kind: "busy" });
    } else {
      if (outcome.status === 502) onAgentDown();
      setRun({ kind: "failed", error: outcome.body.error ?? `The agent answered ${outcome.status}.` });
    }
  }, [api, owner, plan.id, signMessage, refreshEvents, onSettled, onAgentDown]);

  // The demo attack (D15): offered only for a plan whose one payable row is the demo address.
  const tryAnyway = useCallback(async () => {
    setAttack({ stage: "sending" });
    const sent = await api<{ results: AttackResultJson[] }>(`plans/${plan.id}/attack`, { body: {} });
    await refreshEvents();
    if (sent.ok && sent.body.results[0]) {
      setAttack({ stage: "done", result: sent.body.results[0] });
      onSettled({ attackRefused: sent.body.results[0].status === "reverted" });
    } else {
      if (sent.status === 502 && sent.body.error === "agent unreachable") onAgentDown();
      setAttack({ stage: "failed", error: sent.body.error ?? `The agent answered ${sent.status}.` });
    }
  }, [api, plan.id, refreshEvents, onSettled, onAgentDown]);

  const payableRows = plan.payments.filter(isExecutable);
  const quotedAt = localQuotedAt(plan.payments);
  const isAttackPlan =
    payableRows.length === 1 && payableRows[0].recipient?.toLowerCase() === DEMO_ATTACK_ADDRESS.toLowerCase();

  const rows = plan.payments.map((payment, i) => {
    const status = rowStatus(payment, i, events, now, results);
    // Unpayable rows already use the joined warnings as their status detail.
    const detail = status.detail === payment.warnings.join(" ") ? undefined : status.detail;
    const messages = [...new Set([detail, ...payment.warnings].filter((text): text is string => Boolean(text)))];
    return { payment, status, messages };
  });
  // A row can still be paid if it's payable, not yet paid and not refused (an unchecked row is
  // checked again by the vault when the plan runs).
  const payable = rows.some(({ payment, status }) => isExecutable(payment) && status.label !== "Paid ✓" && status.tone !== "stop");
  const settled = !payable && !needsCheckAgain(results);
  const everPaid = rows.some(({ status }) => status.label === "Paid ✓");
  const busy = run.kind === "signing" || run.kind === "running";

  const totals = new Map<string, bigint>();
  for (const payment of plan.payments) {
    if (payment.amount !== null) totals.set(payment.token, (totals.get(payment.token) ?? 0n) + BigInt(payment.amount));
  }
  const allPaid = rows.length > 0 && rows.every(({ status }) => status.label === "Paid ✓");
  let title = plan.kind === "payment" ? "Payout plan" : "Agent response";
  if (everPaid) title = allPaid ? "Payout receipt" : "Payment progress · requested amounts";
  return (
    <div className="card plan">
      <div className="plan-caption">{title}</div>
      {totals.size > 0 && <h2 className="plan-total">
        {Array.from(totals, ([token, total]) => formatAmount(total.toString(), token)).join(" + ")}
      </h2>}
      {plan.kind === "payment" && <p className="meta">
        {plan.payments.length} payment{plan.payments.length === 1 ? "" : "s"} · {plan.scheduledFor === "now" ? "Pay now" : `Scheduled for ${plan.scheduledFor}`}
      </p>}

      {rows.map(({ payment, status, messages }, i) => (
        <div className="row" key={i}>
          <span className="who" title={payment.recipientName}>
            {/^0x[0-9a-fA-F]{40}$/.test(payment.recipientName) ? "Unknown address" : payment.recipientName}
            {payment.recipient && <small>{shortAddress(payment.recipient)}</small>}
          </span>
          <span className="amount">
            {formatAmount(payment.amount, payment.token)}
            {formatLocal(payment.local) && <small>{formatLocal(payment.local)}</small>}
            {payment.local && "error" in payment.local && (
              <small title={payment.local.error}>
                no {payment.local.currency} rate
              </small>
            )}
          </span>
          <span className={`badge ${status.tone}`}>
            {status.hash ? (
              <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
                {status.label} · BscScan ↗
              </a>
            ) : (
              status.label === "Vault check passes" ? "✓ Within limits" : status.label
            )}
          </span>
          {messages.length > 0 && <div className="why">
            {excerpt(messages[0])}{messages.length > 1 && ` · +${messages.length - 1} more`}
          </div>}
        </div>
      ))}

      {plan.depeg && (!plan.depeg.available || plan.depeg.chosenToken === "USDT") && (
        <p className="notice">{plan.depeg.available ? "Depeg guard selected USDT." : "Depeg check unavailable."}</p>
      )}
      {plan.memory?.writeError && <p className="memory-warn">Memory save unavailable.</p>}
      {notes.length > 0 && <p className="plan-note">{excerpt(notes[0])}{notes.length > 1 && ` · +${notes.length - 1} notes`}</p>}
      <button type="button" className="checks-trigger" aria-haspopup="dialog" onClick={() => checksDialog.current?.showModal()}>
        Checks &amp; notes <span aria-hidden="true">↗</span>
      </button>
      <dialog className="checks-dialog" ref={checksDialog} aria-label="Checks and notes"
        onClick={(event) => { if (event.target === checksDialog.current) checksDialog.current?.close(); }}>
        <div className="checks-sheet">
          <header><h2>Checks &amp; notes</h2><button type="button" className="chip" onClick={() => checksDialog.current?.close()}>Close</button></header>
          <div className="checks-content">
            <p className="meta">Plan {shortAddress(plan.ref)}</p>
            {rows.length > 0 && <section><h3>Vault checks</h3>
              {rows.map(({ payment, status, messages }, index) => <div className="check-result" key={index}>
                <strong>{payment.recipientName}</strong>
                <span className={`badge ${status.tone}`}>{status.label}</span>
                {messages.length > 0 && <ul>{messages.map((message) => <li key={message}>{message}</li>)}</ul>}
              </div>)}
            </section>}
            {notes.length > 0 && <section><h3>Plan notes</h3><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}</ul></section>}
            {quotedAt && <p className="meta fx-source">Local estimates · CoinMarketCap, {readingTime(quotedAt)}. Settled in stablecoins.</p>}
            {plan.depeg && <details><summary>Stablecoin risk</summary><DepegBox depeg={plan.depeg} /></details>}
            {plan.memory && <details><summary>Recalled notes</summary><MemoryBox memory={plan.memory} /></details>}
          </div>
        </div>
      </dialog>

      {run.kind === "busy" && (
        <div className="notice">
          Another plan is running.{" "}
          <button className="btn small-btn" onClick={approve}>
            Retry
          </button>
        </div>
      )}
      {run.kind === "failed" && <div className="error-card"><p>{run.error}</p></div>}

      {isAttackPlan && plan.vault && (
        <div className="attack-flow">
          <p className="flagged">Unlisted recipient. Do not approve this payment.</p>
          {attack.stage === "idle" && (
            <div className="actions">
              <button className="btn danger" onClick={tryAnyway}>
                Try anyway (demo)
              </button>
              <span className="hint">Tests the vault’s refusal without your signature.</span>
            </div>
          )}
          {attack.stage === "sending" && <p className="busy">Demo: the agent is submitting it anyway…</p>}
          {attack.stage === "done" && <RefusalCard result={attack.result} balance={null} />}
          {attack.stage === "failed" && (
            <div className="error-card">
              <p>{attack.error}</p>
            </div>
          )}
        </div>
      )}

      {plan.kind === "payment" && plan.vault && !settled && !isAttackPlan && (
        <div className="actions">
          {needsCheckAgain(results) ? (
            <button className="btn" onClick={approve} disabled={busy}>
              Check again
            </button>
          ) : (
            payable && (
              <button className="btn" onClick={approve} disabled={busy}>
                {run.kind === "signing" ? "Waiting for your wallet…" : run.kind === "running" ? "Paying…" : run.kind === "failed" ? "Try again" : "Approve with wallet"}
              </button>
            )
          )}
          <span className="hint">
            {run.kind === "running" ? "Checking each payment…" : "Approval expires in 10 min."}
          </span>
        </div>
      )}
    </div>
  );
}
