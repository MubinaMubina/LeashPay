"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { requestChatTurn, type ChatEntry } from "@/lib/chat-turn";
import { useApi } from "@/lib/client";
import { DEMO_MESSAGES } from "@/lib/demo";
import type { JournalEventJson, PlanJson } from "@/lib/plan-progress";
import { BalanceCard, ChatCard, HelpCard, RecipientPreviewCard } from "./ChatCards";
import { PlanCard } from "./PlanCard";
import { AddRecipientForm, type RecipientBook } from "./Recipients";

const CHIPS = [DEMO_MESSAGES.happyPath, DEMO_MESSAGES.attack, DEMO_MESSAGES.buildTest];

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
      }).catch(() => { if (!ignore) setRestoreFailed(true); });
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

  function renderEntry(entry: ChatEntry, index: number) {
    switch (entry.kind) {
      case "owner": return <div className="me" key={index}>{entry.text}</div>;
      case "plan": return <PlanCard key={entry.plan.id} plan={entry.plan} initialEvents={entry.events} onSettled={onSettled} onAgentDown={onAgentDown} />;
      case "help": return <HelpCard key={index} onAction={openAction} />;
      case "balance": return <BalanceCard key={index} />;
      case "recipients": return <RecipientPreviewCard key={index} book={book} onViewAll={onViewAll} />;
      case "clarify": return <ChatCard key={index} title={entry.question}>{null}</ChatCard>;
      case "notice": return <ChatCard key={index} title={entry.title}>{null}</ChatCard>;
      case "error": return <div className="card error-card" role="alert" key={index}>{entry.text}</div>;
      case "add": {
        const finish = (title: string) => setEntries((list) =>
          list.map((item, i) => i === index ? { kind: "notice", title } : item));
        return (
          <ChatCard key={index} title="Add a recipient">
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
      <div className="log" ref={logRef} role="log" aria-label="Conversation">
        {restored && (
          <>
            <div className="me">{restored.plan.message}</div>
            <PlanCard plan={restored.plan} initialEvents={restored.events} onSettled={onSettled} onAgentDown={onAgentDown} />
          </>
        )}
        {restoreFailed && <ChatCard title="Couldn’t reopen the saved payment">
          <button type="button" className="link" onClick={() => setRestoreAttempt((n) => n + 1)}>Retry</button>
        </ChatCard>}
        {entries.length === 0 && !restored && <HelpCard onAction={openAction} />}
        {entries.map(renderEntry)}
        {thinking && <p className="busy" role="status">Working on your request…</p>}
      </div>
      <div className="composer-wrap">
        <div className="chips">
          {CHIPS.map((chip) => (
            <button key={chip} className="chip" onClick={() => { setText(chip); composer.current?.focus(); }} title={chip}>
              {chip.length > 48 ? `${chip.slice(0, 46)}…` : chip}
            </button>
          ))}
        </div>
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(text); }}>
          <input ref={composer} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)}
            aria-label="Message the agent" placeholder="Message the agent…" readOnly={thinking} />
          <button className="btn" type="submit" disabled={thinking || !text.trim()}>Send</button>
        </form>
      </div>
    </section>
  );
}
