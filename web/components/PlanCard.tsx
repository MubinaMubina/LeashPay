"use client";

import { useSignMessage } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { explorerTx, shortAddress } from "@/lib/chain";
import { DEMO_ATTACK_ADDRESS } from "@/lib/demo";
import { RefusalCard, type AttackResultJson } from "./RefusalCard";
import { errorText, useApi, useOwnerWallet } from "@/lib/client";
import {
  formatAmount,
  isExecutable,
  needsCheckAgain,
  rowStatus,
  type JournalEventJson,
  type PaymentResultJson,
  type PlanJson,
} from "@/lib/plan-progress";

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
 * One plan: each payment with the vault's verdict, then "Approve with my wallet". The card
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
  const api = useApi();
  const owner = useOwnerWallet();
  const { signMessage } = useSignMessage();
  const [events, setEvents] = useState(initialEvents);
  const [results, setResults] = useState<PaymentResultJson[] | undefined>();
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const [attack, setAttack] = useState<Attack>({ stage: "idle" });

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
  const isAttackPlan =
    payableRows.length === 1 && payableRows[0].recipient?.toLowerCase() === DEMO_ATTACK_ADDRESS.toLowerCase();

  const rows = plan.payments.map((payment, i) => ({ payment, status: rowStatus(payment, i, events, now, results) }));
  // A row can still be paid if it's payable, not yet paid and not refused (an unchecked row is
  // checked again by the vault when the plan runs).
  const payable = rows.some(({ payment, status }) => isExecutable(payment) && status.label !== "Paid ✓" && status.tone !== "stop");
  const settled = !payable && !needsCheckAgain(results);
  const everPaid = rows.some(({ status }) => status.label === "Paid ✓");
  const busy = run.kind === "signing" || run.kind === "running";

  return (
    <div className="card plan">
      <h4>{everPaid ? "Payments" : plan.kind === "payment" ? `Plan for ${plan.payments.length} payment${plan.payments.length === 1 ? "" : "s"}` : "Not a payment"}</h4>
      <div className="meta">
        ref {shortAddress(plan.ref)} · {plan.scheduledFor === "now" ? "pay now" : `scheduled for ${plan.scheduledFor}`}
      </div>

      {rows.map(({ payment, status }, i) => (
        <div className="row" key={i}>
          <span className="who" title={payment.recipientName}>
            {/^0x[0-9a-fA-F]{40}$/.test(payment.recipientName) ? "Unknown address" : payment.recipientName}
            {payment.recipient && <small>{shortAddress(payment.recipient)}</small>}
          </span>
          <span className="amount">{formatAmount(payment.amount, payment.token)}</span>
          <span className={`badge ${status.tone}`}>
            {status.hash ? (
              <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
                {status.label} · BscScan ↗
              </a>
            ) : (
              status.label
            )}
          </span>
          {(status.detail || payment.warnings.length > 0) && (
            <div className="why">{[...payment.warnings, status.detail].filter(Boolean).join(" ")}</div>
          )}
        </div>
      ))}

      {plan.notes.length > 0 && (
        <ul className="notes">
          {plan.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}

      {run.kind === "busy" && (
        <div className="notice">
          The agent is finishing another plan.{" "}
          <button className="btn small-btn" onClick={approve}>
            Retry
          </button>
        </div>
      )}
      {run.kind === "failed" && <div className="error-card"><p>{run.error}</p></div>}

      {isAttackPlan && plan.vault && (
        <div className="attack-flow">
          <p className="flagged">Claude flagged this: the address isn't one of your recipients, so you shouldn't approve it.</p>
          {attack.stage === "idle" && (
            <div className="actions">
              <button className="btn danger" onClick={tryAnyway}>
                Try anyway (demo)
              </button>
              <span className="hint">Plays a hacked agent that pays without your signature. The vault decides.</span>
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
                {run.kind === "signing" ? "Waiting for your wallet…" : run.kind === "running" ? "Paying…" : run.kind === "failed" ? "Try again" : "Approve with my wallet"}
              </button>
            )
          )}
          <span className="hint">
            {run.kind === "running" ? "Each payment is checked by the vault as it goes." : "Your signature is valid for 10 minutes."}
          </span>
        </div>
      )}
    </div>
  );
}
