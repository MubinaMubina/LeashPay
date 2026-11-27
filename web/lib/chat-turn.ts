import type { Address } from "viem";
import type { useApi } from "./client";
import type { JournalEventJson, PlanJson } from "./plan-progress";
import type { RecipientForm } from "./recipients";

export type ChatAction = "help" | "balance" | "recipients" | "add" | "payment";
export type ChatRequest =
  | { kind: "chat"; message: string; context: string[] }
  | { kind: "review"; message: string };

export type ChatEntry =
  | { kind: "owner"; text: string }
  | { kind: "help" } | { kind: "balance" } | { kind: "recipients" } | { kind: "access" }
  | { kind: "add"; fields: Partial<RecipientForm> }
  | { kind: "added"; name: string }
  | { kind: "draft"; source: string[]; candidates?: string[] }
  | { kind: "plan"; plan: PlanJson; events: JournalEventJson[] }
  | { kind: "error"; retry: ChatRequest; status: number; agentDown: boolean };

type Turn = { entry: ChatEntry; context: string[] };
type Api = ReturnType<typeof useApi>;
const access = (): Turn => ({ entry: { kind: "access" }, context: [] });

/** A second click on an open shortcut keeps the same card, including its edits. */
export function openChatAction(entries: ChatEntry[], action: ChatAction | "access"): ChatEntry[] {
  const last = entries.at(-1);
  if (action === "payment") {
    if (last?.kind === "draft") return entries;
    return [...entries, { kind: "draft", source: [] }];
  }
  if (last?.kind === action) return entries;
  return [...entries, action === "add" ? { kind: "add", fields: {} } : { kind: action }];
}

function failure(request: ChatRequest, status: number, error?: unknown): Turn {
  return {
    entry: { kind: "error", retry: request, status, agentDown: status === 502 && error === "agent unreachable" },
    context: request.kind === "chat" ? request.context : [request.message],
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
const units = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);

/** Validate the quote fields the card uses for labels, arithmetic and subsequent wallet review. */
export function readableQuote(value: unknown): value is PlanJson {
  if (!isRecord(value) || (value.kind !== "payment" && value.kind !== "not_a_payment")) return false;
  if (typeof value.id !== "string" || !value.id || typeof value.ref !== "string" || typeof value.message !== "string"
    || typeof value.owner !== "string" || (value.vault !== null && typeof value.vault !== "string")
    || typeof value.scheduledFor !== "string" || !strings(value.notes) || !Array.isArray(value.payments)) return false;
  const fee = value.paymentFee;
  if (fee !== undefined && !(isRecord(fee) && fee.token === "USDT" && units(fee.amount) && typeof fee.recipient === "string")) return false;
  return value.payments.every(row => isRecord(row) && typeof row.recipientName === "string" && strings(row.warnings)
    && (typeof row.recipient === "string" || row.recipient === null) && (units(row.amount) || row.amount === null)
    && (row.token === "USDT" || row.token === "USDC"));
}

function addFields(value: unknown): Partial<RecipientForm> | null {
  if (!isRecord(value)) return null;
  const fields: Partial<RecipientForm> = {};
  for (const key of ["name", "country", "address", "currency", "monthlyCap"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") return null;
    fields[key] = value[key];
  }
  return fields;
}

/** An older Railway release can return a free-form question. The card uses only owner turns and choices. */
function paymentDraft(card: Record<string, unknown>, context: string[], message: string): Turn | null {
  const start = card.contextStart;
  let prior: string[] = [];
  if (start === undefined) {
    // Older agents did not identify the first relevant turn. Keep a follow-up with its request.
    if (!/\b(?:pay|send|transfer|paie|paye|payer|envoie|envoyer|vire|verse)\b/iu.test(message)) prior = context;
  } else if (start !== null) {
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0 || start >= context.length) return null;
    prior = context.slice(start);
  }
  const source = [...prior, message];
  const candidates = card.candidates;
  if (candidates !== undefined && !strings(candidates)) return null;
  return {
    entry: { kind: "draft", source, ...(candidates?.length ? { candidates } : {}) },
    context: source.slice(-6),
  };
}

export function needsPaymentDetails(plan: PlanJson) {
  return plan.kind === "not_a_payment" || (plan.kind === "payment" && Array.isArray(plan.payments)
    && plan.payments.every(payment => payment?.recipient === null));
}

/** Only PlanCard requests wallet approval. This endpoint returns an unsigned quote. */
export async function requestPaymentReview(api: Api, owner: Address | null, message: string,
  depegThreshold: number, isCurrent: () => boolean): Promise<Turn | null> {
  if (!owner) return access();
  const retry = { kind: "review", message } as const;
  try {
    const plan = await api<PlanJson>("plans", { body: { owner, message, depegThreshold } });
    if (!isCurrent()) return null;
    if (!plan.ok) return failure(retry, plan.status, plan.body?.error);
    const body = plan.body;
    if (!readableQuote(body)) return failure(retry, 502);
    if (needsPaymentDetails(body)) {
      return { entry: { kind: "draft", source: [message] }, context: [message] };
    }
    return { entry: { kind: "plan", plan: body, events: [] }, context: [] };
  } catch {
    return isCurrent() ? failure(retry, 0) : null;
  }
}

export async function requestChatTurn(api: Api, owner: Address | null, message: string, context: string[],
  depegThreshold: number, isCurrent: () => boolean): Promise<Turn | null> {
  if (!owner) return access();
  const retry = { kind: "chat", message, context } as const;
  try {
    const decision = await api<unknown>("chat", { body: { owner, message, context } });
    if (!isCurrent()) return null;
    if (!decision.ok) return failure(retry, decision.status, decision.body?.error);
    const card: unknown = decision.body;
    if (!isRecord(card)) return failure(retry, 502);
    switch (card.kind) {
      case "help": case "balance": case "recipients":
        return { entry: { kind: card.kind }, context: [] };
      case "add": {
        const fields = addFields(card.fields);
        if (fields) return { entry: { kind: "add", fields }, context: [] };
        break;
      }
      case "clarify":
        return paymentDraft(card, context, message) ?? failure(retry, 502);
      case "payment":
        if (typeof card.message === "string" && card.message.trim() && card.message.length <= 2000) {
          return requestPaymentReview(api, owner, card.message, depegThreshold, isCurrent);
        }
        break;
    }
    return failure(retry, 502);
  } catch {
    return isCurrent() ? failure(retry, 0) : null;
  }
}
