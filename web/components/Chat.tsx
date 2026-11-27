"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { needsPaymentDetails, openChatAction, readableQuote, requestChatTurn, requestPaymentReview, type ChatAction, type ChatEntry, type ChatRequest } from "@/lib/chat-turn";
import { useApi } from "@/lib/client";
import { DEMO_MESSAGES } from "@/lib/demo";
import type { JournalEventJson, PlanJson } from "@/lib/plan-progress";
import { BalanceCard, ChatCard, HelpCard, RecipientPreviewCard } from "./ChatCards";
import { PlanCard } from "./PlanCard";
import { PaymentDraftCard } from "./PaymentDraftCard";
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
  owner: Address | null;
  vault: Address | null;
  accessNotice: ReactNode;
  agent: Address | null | undefined;
  book: RecipientBook;
  onViewAll: () => void;
  onSettled: (outcome?: { attackRefused?: boolean }) => void;
  onAgentDown: () => void;
  depegThreshold: number;
}

function DraftReply({ entry, vault, agent, book, busy, onReview, onRequest }: Pick<ChatProps, "agent" | "book"> & {
  entry: Extract<ChatEntry, { kind: "draft" }>; vault: Address; busy: boolean;
  onReview: (message: string) => void; onRequest: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return <>
    <div hidden={adding}>
      <PaymentDraftCard book={book} source={entry.source} candidates={entry.candidates} busy={busy}
        onReview={onReview} onRequest={onRequest} onAddRecipient={() => setAdding(true)} />
    </div>
    {adding && <ChatCard title="Add a recipient">
      <AddRecipientForm vault={vault} agent={agent} book={book} initial={{}}
        onCancel={() => setAdding(false)} onAdded={() => setAdding(false)} />
    </ChatCard>}
  </>;
}

function replyError(status: number, review: boolean) {
  if (status === 401 || status === 403) return "Your session could not be verified. Check that you’re signed in.";
  if (status === 429) return "The agent is busy. Try again in a moment.";
  if (status === 0) return "Check your connection and try again.";
  return review ? "Try the quote again or edit the payment details." : "Try your request again or choose an action.";
}

export function Chat({ owner, vault, accessNotice, agent, book, onViewAll, onSettled, onAgentDown, depegThreshold }: ChatProps) {
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
    if (!owner || !vault) return;
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
        const saved = found.ok && readableQuote(found.body?.plan)
          && found.body.plan.id === id && Array.isArray(found.body.events);
        setRestoreFailed(!saved);
        if (saved) setRestored(found.body);
      }).catch(() => { if (!ignore) setRestoreFailed(true); })
      .finally(() => { if (!ignore) setRestoring(false); });
    return () => { ignore = true; };
  }, [api, owner, vault, restoreAttempt]);

  async function submit(request: ChatRequest, replaceIndex?: number) {
    if (!request.message.trim() || sending.current) return;
    sending.current = true;
    setThinking(true);
    if (replaceIndex === undefined) {
      setText("");
      setEntries(list => [...list, { kind: "owner", text: request.message }]);
    }
    try {
      const activeOwner = vault ? owner : null;
      const current = () => active.current;
      const turn = request.kind === "review"
        ? await requestPaymentReview(api, activeOwner, request.message, depegThreshold, current)
        : await requestChatTurn(api, activeOwner, request.message, request.context, depegThreshold, current);
      if (!turn || !active.current) return;
      pending.current = turn.context;
      if (turn.entry.kind === "plan") rememberPlan(turn.entry.plan.id);
      if (turn.entry.kind === "error" && turn.entry.agentDown) onAgentDown();
      setEntries(list => replaceIndex === undefined
        ? [...list, turn.entry]
        : list.map((item, i) => i === replaceIndex ? turn.entry : item));
    } finally {
      sending.current = false;
      if (active.current) setThinking(false);
    }
  }

  function send(text: string) {
    return submit({ kind: "chat", message: text.trim(), context: pending.current });
  }

  function openAction(action: ChatAction) {
    if (sending.current) return;
    const allowed = vault && owner ? action : "access";
    const last = entries.at(-1);
    if (last?.kind === "draft" && allowed === "payment") {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    } else {
      pending.current = [];
    }
    setEntries(list => openChatAction(list, allowed));
  }

  function replace(index: number, entry: ChatEntry) {
    setEntries(list => list.map((item, i) => i === index ? entry : item));
  }

  function renderReply(entry: Exclude<ChatEntry, { kind: "owner" }>, index: number) {
    switch (entry.kind) {
      case "access": return accessNotice ?? <HelpCard onAction={openAction} />;
      case "plan": return <PlanCard plan={entry.plan} initialEvents={entry.events} onSettled={onSettled} onAgentDown={onAgentDown} />;
      case "help": return <HelpCard onAction={openAction} />;
      case "balance": return <BalanceCard />;
      case "recipients": return <RecipientPreviewCard book={book} onViewAll={onViewAll} onAdd={() => openAction("add")} />;
      case "draft": return vault && owner
        ? <DraftReply key={JSON.stringify(entry.source)} entry={entry} vault={vault} agent={agent} book={book} busy={thinking}
            onReview={message => void submit({ kind: "review", message }, index)}
            onRequest={message => {
              const prior = entry.source.slice(0, -1);
              const prefix = prior.length ? prior.join("\n") + "\n" : "";
              const continuation = prefix && message.startsWith(prefix) && message.slice(prefix.length).trim();
              void submit(continuation
                ? { kind: "chat", message: continuation, context: prior.slice(-6) }
                : { kind: "chat", message, context: [] }, index);
            }} />
        : accessNotice;
      case "added": return <ChatCard title="Recipient added">
        <dl className="balances"><div className="kv"><dt>Recipient</dt><dd>{entry.name}</dd></div></dl>
        <div className="actions">
          <button className="btn" type="button" onClick={() => openAction("payment")}>Prepare a payment</button>
          <button className="chip" type="button" onClick={onViewAll}>View all recipients</button>
        </div>
      </ChatCard>;
      case "error": return <ChatCard title={entry.retry.kind === "review" ? "Payment preview unavailable" : "Chat action unavailable"}>
        <p className="hint" role="alert">{replyError(entry.status, entry.retry.kind === "review")}</p>
        <div className="actions">
          <button className="btn" type="button" disabled={thinking} onClick={() => void submit(entry.retry, index)}>Retry</button>
          {entry.retry.kind === "review" && <button className="chip" type="button" disabled={thinking} onClick={() => {
            pending.current = [entry.retry.message];
            replace(index, { kind: "draft", source: pending.current });
          }}>Edit payment</button>}
          <button className="chip" type="button" disabled={thinking} onClick={() => openAction("help")}>Show actions</button>
        </div>
      </ChatCard>;
      case "add": {
        if (!vault) return accessNotice;
        return (
          <ChatCard title="Add a recipient">
            <AddRecipientForm vault={vault} agent={agent} book={book} initial={entry.fields}
              onCancel={() => replace(index, { kind: "help" })}
              onAdded={name => replace(index, { kind: "added", name })} />
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
              <button className="chip" onClick={() => openAction("balance")}>Check my balance</button>
              <button className="chip" onClick={() => openAction("help")}>What can you do?</button>
            </div>
          </div>
        )}
        {restored && (
          <>
            <div className="me">{restored.plan.message}</div>
            <AgentReply>{restored.plan.kind === "payment" && !needsPaymentDetails(restored.plan)
              ? <PlanCard plan={restored.plan} initialEvents={restored.events} onSettled={onSettled} onAgentDown={onAgentDown} />
              : <HelpCard onAction={openAction} />}</AgentReply>
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
