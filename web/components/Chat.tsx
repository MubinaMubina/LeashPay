"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/client";
import { DEMO_MESSAGES } from "@/lib/demo";
import type { JournalEventJson, PlanJson } from "@/lib/plan-progress";
import { PlanCard } from "./PlanCard";

type Entry =
  | { kind: "owner"; text: string }
  | { kind: "plan"; plan: PlanJson; events: JournalEventJson[] }
  | { kind: "error"; text: string };

const CHIPS = [DEMO_MESSAGES.happyPath, DEMO_MESSAGES.attack, DEMO_MESSAGES.buildTest];

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
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, thinking]);

  // A reload with ?plan=<id> brings back that plan and its progress.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("plan");
    if (!id) return;
    void (async () => {
      const found = await api<{ plan: PlanJson; events: JournalEventJson[] }>(`plans/${encodeURIComponent(id)}`);
      if (found.ok) setEntries([{ kind: "owner", text: found.body.plan.message }, { kind: "plan", ...found.body }]);
    })();
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
      <div className="log" ref={logRef}>
        {entries.length === 0 && (
          <p className="hint empty">Tell the agent who to pay. It plans; your vault checks every payment; you approve with your wallet.</p>
        )}
        {entries.map((entry, i) =>
          entry.kind === "owner" ? (
            <div className="me" key={i}>
              {entry.text}
            </div>
          ) : entry.kind === "plan" ? (
            <PlanCard key={entry.plan.id} plan={entry.plan} initialEvents={entry.events} onSettled={onSettled} onAgentDown={onAgentDown} />
          ) : (
            <div className="card error-card" key={i}>
              <p>{entry.text}</p>
            </div>
          ),
        )}
        {thinking && <p className="busy">The agent is planning…</p>}
      </div>

      <div className="composer-wrap">
        <div className="chips">
          {CHIPS.map((chip) => (
            <button key={chip} className="chip" onClick={() => setText(chip)} title={chip}>
              {chip.length > 48 ? `${chip.slice(0, 46)}…` : chip}
            </button>
          ))}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Tell the agent who to pay…" disabled={thinking} />
          <button className="btn" type="submit" disabled={thinking || !text.trim()}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
