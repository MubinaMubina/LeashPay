import type { Address } from "viem";
import type { VaultSnapshot } from "./chain/gateway";
import type { JournalEvent } from "./execution/journal";
import type { PlanJson } from "./json";
import { isCalendarDate } from "./plan/build";
import type { TokenSymbol } from "./plan/directory";

const TOKENS = ["USDT", "USDC"] as const;
const DAYS = 30;
const DAY_MS = 86_400_000;

type Amounts = Record<TokenSymbol, bigint>;

interface DatedPlan {
  plan: PlanJson;
  included: boolean;
  paid: Set<number>;
  pending: Set<number>;
}

export function buildRunway(events: readonly JournalEvent[], owner: Address, vault: VaultSnapshot, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const start = Date.parse(today);
  const dayAt = (offset: number) => new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
  const end = dayAt(DAYS - 1);
  const dated = new Map<string, DatedPlan>();

  // Read the journal in order. An early or partial payment must disappear from the forecast
  // even if the owner later retries that plan or restarts the agent.
  for (const event of events) {
    if (event.type === "plan_created") {
      const plan = event.plan;
      if (plan.owner === owner && plan.vault === vault.vault && plan.kind === "payment" &&
          isCalendarDate(plan.scheduledFor) && plan.scheduledFor <= end) {
        dated.set(plan.id, { plan, included: false, paid: new Set(), pending: new Set() });
      }
      continue;
    }
    const item = dated.get(event.planId);
    if (!item) continue;
    if (event.type === "runway_inclusion") item.included = event.included;
    if (event.type === "step_sent") item.pending.add(event.index);
    if (event.type === "step_failed" || event.type === "step_refused" || event.type === "step_succeeded") {
      item.pending.delete(event.index);
    }
    if (event.type === "step_succeeded") item.paid.add(event.index);
  }

  const plans = [];
  const outflows = Array.from({ length: DAYS }, (): Amounts => ({ USDT: 0n, USDC: 0n }));
  let awaitingReceipt = false;
  for (const { plan, included, paid, pending } of dated.values()) {
    if (plan.scheduledFor < today && !included) continue;
    const payments = plan.payments.flatMap((p, i) =>
      !paid.has(i) && p.recipient && p.amount !== null && BigInt(p.amount) > 0n
        ? [{ name: p.recipientName, amount: p.amount, token: p.token, pending: pending.has(i) }] : []);
    if (!payments.length) continue;
    const feesUSDT = BigInt(plan.paymentFee?.amount ?? 0) * BigInt(payments.length);
    plans.push({ id: plan.id, date: plan.scheduledFor, included, payments,
      ...(feesUSDT > 0n && { feesUSDT: feesUSDT.toString() }) });
    if (!included) continue;
    const day = Math.max(0, (Date.parse(plan.scheduledFor) - start) / DAY_MS);
    outflows[day]!.USDT += feesUSDT;
    for (const payment of payments) {
      if (payment.pending) awaitingReceipt = true;
      outflows[day]![payment.token] += BigInt(payment.amount);
    }
  }
  plans.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const opening: Amounts = { USDT: vault.balances.USDT, USDC: vault.balances.USDC };
  const base = { asOf: now.toISOString(), today, end, opening, plans };
  // A broadcast may already be reflected in the chain balance before its receipt is journaled.
  if (awaitingReceipt) return { ...base, projection: null };

  const remaining = { ...opening };
  const firstShortfall: { date: string; token: TokenSymbol; amount: bigint }[] = [];
  const weeks = [];
  for (let first = 0; first < DAYS; first += 7) {
    const last = Math.min(first + 6, DAYS - 1);
    const due: Amounts = { USDT: 0n, USDC: 0n };
    for (let day = first; day <= last; day++) {
      for (const token of TOKENS) {
        const amount = outflows[day]![token];
        due[token] += amount;
        remaining[token] -= amount;
        if (remaining[token] < 0n && !firstShortfall.some(s => s.token === token)) {
          firstShortfall.push({ date: dayAt(day), token, amount: -remaining[token] });
        }
      }
    }
    const short = TOKENS.some(token => remaining[token] < 0n);
    const tight = TOKENS.some(token => {
      const nextWeek = outflows.slice(last + 1, last + 8).reduce((sum, d) => sum + d[token], 0n);
      return (due[token] > 0n && remaining[token] === 0n) || remaining[token] < nextWeek;
    });
    weeks.push({ from: dayAt(first), through: dayAt(last), due, closing: { ...remaining },
      status: short ? "short" : tight ? "tight" : "covered" });
  }
  return { ...base, projection: { weeks, closing: remaining, firstShortfall } };
}
