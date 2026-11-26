import type { Address } from "viem";
import type { useApi } from "./client";
import type { JournalEventJson, PlanJson } from "./plan-progress";
import type { RecipientForm } from "./recipients";

type ToolCard =
  | { kind: "help" } | { kind: "balance" } | { kind: "recipients" }
  | { kind: "add"; fields: Partial<RecipientForm> }
  | { kind: "clarify"; question: string };
type Decision = ToolCard | { kind: "payment"; message: string };
export type ChatEntry = ToolCard
  | { kind: "owner"; text: string }
  | { kind: "plan"; plan: PlanJson; events: JournalEventJson[] }
  | { kind: "notice"; title: string }
  | { kind: "error"; text: string; agentDown?: boolean };

/** The classifier can open cards or prepare a plan. Wallet approvals live in the cards. */
export async function requestChatTurn(
  api: ReturnType<typeof useApi>, owner: Address, message: string, context: string[],
  depegThreshold: number, isCurrent: () => boolean,
): Promise<{ entry: ChatEntry; context: string[] } | null> {
  const decision = await api<Decision>("chat", { body: { owner, message, context } });
  if (!isCurrent()) return null;
  const failure = (status: number, error?: string, remaining = context) => ({
    entry: {
      kind: "error" as const,
      text: error ?? `The agent answered ${status}.`,
      agentDown: status === 502 && error === "agent unreachable",
    },
    context: remaining,
  });
  if (!decision.ok) return failure(decision.status, decision.body.error);
  const card = decision.body;
  if (card.kind === "clarify") return { entry: card, context: [...context, message].slice(-6) };
  if (card.kind !== "payment") return { entry: card, context: [] };

  const plan = await api<PlanJson>("plans", { body: { owner, message: card.message, depegThreshold } });
  if (!isCurrent()) return null;
  if (!plan.ok) return failure(plan.status, plan.body.error, [card.message]);
  return { entry: { kind: "plan", plan: plan.body, events: [] }, context: [] };
}
