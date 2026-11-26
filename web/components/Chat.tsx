"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { requestChatTurn, type ChatEntry } from "@/lib/chat-turn";
import { useApi } from "@/lib/client";
import { DEMO_MESSAGES } from "@/lib/demo";
import type { JournalEventJson, PlanJson } from "@/lib/plan-progress";
import { BalanceCard, ChatCard, HelpCard, RecipientPreviewCard } from "./ChatCards";
import { PlanCard } from "./PlanCard";
import type { RecipientBook } from "@/lib/recipient-book";
import { AddRecipientForm } from "./RecipientForm";
import { BrandMark } from "./Brand";
import { Skeleton } from "./Skeleton";

const EXAMPLES = [
  ["Freelancer payroll", DEMO_MESSAGES.happyPath],
  ["Small test payout", DEMO_MESSAGES.buildTest],
  ["Blocked payment demo", DEMO_MESSAGES.attack],
];

function AgentReply({ children }: { children: ReactNode }) {
  return <div className="agent-reply">
    <div className="agent-name"><BrandMark /> LeashPay agent</div>
    {children}
  </div>;
}

function rememberPlan(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("plan", id);
  window.history.replaceState(null, "", url);
}

interface ChatProps {
  owner: Address;
  vault: Address;
  agent: Address | null | undefined;
  book: RecipientBook;
  onViewAll: () => void;
  onSettled: (outcome?: { attackRefused?: boolean }) => void;
  onAgentDown: () => void;
  depegThreshold: number;
}

export function Chat({ owner, vault, agent, book, onViewAll, onSettled, onAgentDown, depegThreshold }: ChatProps) {
  const api = useApi();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [restored, setRestored] = useState<{ plan: PlanJson; events: JournalEventJson[] } | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const initialPlan = useRef<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const examples = useRef<HTMLDivElement>(null);
  const [restoring, setRestoring] = useState(false);
  const pending = useRef<string[]>([]);
  const active = useRef(true);
  const sending = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries, thinking]);

  useEffect(() => {
    if (initialPlan.current === undefined) initialPlan.current = new URLSearchParams(window.location.search).get("plan");
    const id = initialPlan.current;
    if (!id) return;
    let ignore = false;
    setRestoring(true);
    void api<{ plan: PlanJson; events: JournalEventJson[] }>(`plans/${encodeURIComponent(id)}?owner=${owner}`)
      .then((found) => {
        if (ignore) return;
        if (found.status === 403 || found.status === 404) {
          const url = new URL(window.location.href);
          if (url.searchParams.get("plan") === id) {
            url.searchParams.delete("plan");
            window.history.replaceState(null, "", url);
          }
          initialPlan.current = null;
          setRestoreFailed(false);
          return;
        }
        setRestoreFailed(!found.ok);
        if (found.ok) setRestored(found.body);
      }).catch(() => { if (!ignore) setRestoreFailed(true); })
      .finally(() => { if (!ignore) setRestoring(false); });
    return () => { ignore = true; };
  }, [api, owner, restoreAttempt]);

  const send = useCallback(async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || sending.current) return;
    sending.current = true;
    setThinking(true);
    setText("");
    setEntries((list) => [...list, { kind: "owner", text: trimmed }]);
    try {
      const turn = await requestChatTurn(api, owner, trimmed, pending.current, depegThreshold, () => active.current);
      if (!turn || !active.current) return;
      pending.current = turn.context;
      if (turn.entry.kind === "plan") rememberPlan(turn.entry.plan.id);
      if (turn.entry.kind === "error" && turn.entry.agentDown) onAgentDown();
      setEntries((list) => [...list, turn.entry]);
    } catch {
      if (active.current) setEntries((list) => [...list, { kind: "error", text: "Couldn't load the reply. Try sending your message again." }]);
    } finally {
      sending.current = false;
      if (active.current) setThinking(false);
    }
  }, [api, owner, depegThreshold, onAgentDown]);

  function openAction(action: "balance" | "recipients" | "add" | "payment") {
    if (sending.current) return;
    pending.current = [];
    let entry: ChatEntry;
    if (action === "payment") {
      pending.current = ["Prepare a payment"];
      entry = { kind: "clarify", question: "Who would you like to pay, and how much?" };
      composer.current?.focus();
    } else if (action === "add") {
      entry = { kind: "add", fields: {} };
    } else {
      entry = { kind: action };
    }
    setEntries((list) => [...list, entry]);
  }

  function renderReply(entry: Exclude<ChatEntry, { kind: "owner" }>, index: number) {
    switch (entry.kind) {
      case "plan": return <PlanCard plan={entry.plan} initialEvents={entry.events} onSettled={onSettled} onAgentDown={onAgentDown} />;
      case "help": return <HelpCard onAction={openAction} />;
      case "balance": return <BalanceCard />;
      case "recipients": return <RecipientPreviewCard book={book} onViewAll={onViewAll} />;
      case "clarify": return <ChatCard title={entry.question}>{null}</ChatCard>;
      case "notice": return <ChatCard title={entry.title}>{null}</ChatCard>;
      case "error": return <div className="card error-card" role="alert">{entry.text}</div>;
      case "add": {
        const finish = (title: string) => setEntries((list) =>
          list.map((item, i) => i === index ? { kind: "notice", title } : item));
        return (
          <ChatCard title="Add a recipient">
            <AddRecipientForm vault={vault} agent={agent} book={book} initial={entry.fields}
              onCancel={() => finish("Recipient addition cancelled")}
              onAdded={(name) => finish(`You can now pay ${name}`)} />
          </ChatCard>
        );
      }
    }
  }

  return (
    <section className="chat" aria-label="Payment chat">
      <div className="log" ref={logRef} role="log" aria-label="Conversation with LeashPay">
        {!entries.length && !restored && !restoring && !restoreFailed && (
          <div className="empty">
            <BrandMark />
            <h2>Who do you want to pay?</h2>
            <p className="hint">Tell me who and how much. You’ll review the plan before signing.</p>
            <div className="chat-starters">
              <button className="chip" onClick={() => { setText("Pay Linh 1 USDT"); composer.current?.focus(); }}>Try “Pay Linh 1 USDT”</button>
              <button className="chip" onClick={() => setEntries([{ kind: "help" }])}>What can you do?</button>
            </div>
          </div>
        )}
        {restored && (
          <>
            <div className="me">{restored.plan.message}</div>
            <AgentReply><PlanCard plan={restored.plan} initialEvents={restored.events} onSettled={onSettled} onAgentDown={onAgentDown} /></AgentReply>
          </>
        )}
        {restoreFailed && !restoring && <AgentReply><ChatCard title="Couldn’t reopen the saved payment">
          <button type="button" className="link" onClick={() => setRestoreAttempt((n) => n + 1)}>Retry</button>
        </ChatCard></AgentReply>}
        {entries.map((entry, i) => entry.kind === "owner"
          ? <div className="me" key={i}>{entry.text}</div>
          : <AgentReply key={i}>{renderReply(entry, i)}</AgentReply>)}
        {(thinking || restoring) && <AgentReply>
          <Skeleton variant="plan" label={restoring ? "Loading saved plan" : "Working on your request"} />
        </AgentReply>}
      </div>
      <div className="composer-wrap">
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
          <button type="button" className="examples-toggle" popoverTarget="chat-examples" aria-label="Example requests" title="Example requests">+</button>
          <div popover="auto" id="chat-examples" className="examples-menu" ref={examples}>
            {EXAMPLES.map(([label, message]) => (
              <button type="button" key={label} onClick={() => { setText(message); examples.current?.hidePopover(); composer.current?.focus(); }}>{label}</button>
            ))}
          </div>
          <input ref={composer} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)}
            aria-label="Message the agent" placeholder="Message the agent…" readOnly={thinking} />
          <button className="btn" type="submit" disabled={thinking || !text.trim()}>Send</button>
        </form>
      </div>
    </section>
  );
}
