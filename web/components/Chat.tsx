"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/client";
import { DEMO_MESSAGES } from "@/lib/demo";
import type { JournalEventJson, PlanJson } from "@/lib/plan-progress";
import { BrandMark } from "./Brand";
import { Skeleton } from "./Skeleton";
import { PlanCard } from "./PlanCard";

type Entry =
  | { kind: "owner"; text: string }
  | { kind: "plan"; plan: PlanJson; events: JournalEventJson[] }
  | { kind: "error"; text: string };

const EXAMPLES = [
  ["Freelancer payroll", DEMO_MESSAGES.happyPath],
  ["Small test payout", DEMO_MESSAGES.buildTest],
  ["Blocked payment demo", DEMO_MESSAGES.attack],
];

/** Keeps the latest plan in the address bar, so a reload mid-payment resumes the same plan (D16). */
function rememberPlan(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("plan", id);
  window.history.replaceState(null, "", url);
}

export function Chat({
  onSettled,
  onAgentDown,
  depegThreshold,
}: {
  onSettled: (outcome?: { attackRefused?: boolean }) => void;
  onAgentDown: () => void;
  /** The owner's depeg limit in percent, sent with every new plan. */
  depegThreshold: number;
}) {
  const api = useApi();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const examples = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "instant" });
  }, [entries, thinking]);

  // A reload with ?plan=<id> brings back that plan and its progress.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("plan");
    if (!id) return;
    let cancelled = false;
    setRestoring(true);
    void (async () => {
      const found = await api<{ plan: PlanJson; events: JournalEventJson[] }>(`plans/${encodeURIComponent(id)}`);
      if (cancelled) return;
      setRestoring(false);
      if (found.ok) setEntries([{ kind: "owner", text: found.body.plan.message }, { kind: "plan", ...found.body }]);
      else setEntries([{ kind: "error", text: found.body.error || "Couldn’t load the saved plan." }]);
    })();
    return () => { cancelled = true; };
  }, [api]);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || thinking) return;
      setText("");
      setEntries((list) => [...list, { kind: "owner", text: trimmed }]);
      setThinking(true);
      const created = await api<PlanJson>("plans", { body: { message: trimmed, depegThreshold } });
      setThinking(false);
      if (created.ok) {
        rememberPlan(created.body.id);
        setEntries((list) => [...list, { kind: "plan", plan: created.body, events: [] }]);
      } else {
        if (created.status === 502 && created.body.error === "agent unreachable") onAgentDown();
        setEntries((list) => [...list, { kind: "error", text: created.body.error ?? `The agent answered ${created.status}.` }]);
      }
    },
    [api, thinking, onAgentDown, depegThreshold],
  );

  return (
    <section className="chat">
      <div className="log" ref={logRef} role="log" aria-label="Conversation with LeashPay">
        {entries.length === 0 && !restoring && (
          <div className="empty">
            <BrandMark />
            <h2>Who do you want to pay?</h2>
            <p className="hint">Tell me who and how much. You’ll review the plan before signing.</p>
            <button className="chip" onClick={() => { setText("Pay Linh 1 USDT"); input.current?.focus(); }}>Try “Pay Linh 1 USDT”</button>
          </div>
        )}
        {entries.map((entry, i) =>
          entry.kind === "owner" ? (
            <div className="me" key={i}>
              {entry.text}
            </div>
          ) : entry.kind === "plan" ? (
            <div className="agent-reply" key={entry.plan.id}>
              <div className="agent-name"><BrandMark /> LeashPay agent</div>
              <PlanCard plan={entry.plan} initialEvents={entry.events} onSettled={onSettled} onAgentDown={onAgentDown} />
            </div>
          ) : (
            <div className="card error-card" key={i}>
              <p>{entry.text}</p>
            </div>
          ),
        )}
        {(thinking || restoring) && <div className="agent-reply">
          <div className="agent-name"><BrandMark /> LeashPay agent</div>
          <Skeleton label={restoring ? "Loading saved plan" : "Preparing payout plan"} variant="plan" />
        </div>}
      </div>

      <div className="composer-wrap">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <button type="button" className="examples-toggle" popoverTarget="chat-examples" aria-label="Example requests" title="Example requests">+</button>
          <div popover="auto" id="chat-examples" className="examples-menu" ref={examples}>
            {EXAMPLES.map(([label, message]) => (
              <button type="button" key={label} onClick={() => { setText(message); examples.current?.hidePopover(); input.current?.focus(); }}>{label}</button>
            ))}
          </div>
          <input ref={input} aria-label="Message the agent" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the agent…" />
          <button className="btn" type="submit" disabled={thinking || restoring || !text.trim()}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
