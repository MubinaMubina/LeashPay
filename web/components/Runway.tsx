"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useApi } from "@/lib/client";
import { Skeleton } from "./Skeleton";

const coins = ["USDT", "USDC"] as const;
type Coin = typeof coins[number];
type Balances = Record<Coin, string>;
interface RunwayData {
  asOf: string;
  today: string;
  end: string;
  opening: Balances;
  plans: {
    id: string; date: string; included: boolean;
    payments: { name: string; token: Coin; amount: string; pending: boolean }[];
  }[];
  projection: null | {
    closing: Balances;
    firstShortfall: { date: string; token: Coin; amount: string }[];
    weeks: {
      from: string; through: string; due: Balances; closing: Balances; status: "covered" | "tight" | "short";
    }[];
  };
}

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) => dayFormat.format(new Date(iso));

// Keep token precision, including deficits smaller than a cent.
function amount(raw: string): string {
  const units = BigInt(raw);
  const [whole, fraction] = formatUnits(units < 0n ? -units : units, 18).split(".");
  return (units < 0n ? "−" : "") + BigInt(whole).toLocaleString("en-US") + (fraction ? "." + fraction : "");
}

function Forecast({ data }: { data: RunwayData }) {
  const { projection, plans } = data;
  const included = plans.filter(plan => plan.included);
  if (!projection) return <p className="runway-note" role="status">
    A payout is awaiting confirmation. Check its receipt in Payment chat to update the projection.
  </p>;
  const first = projection.firstShortfall[0];
  const tightWeek = projection.weeks.find(week => week.status === "tight");
  return <>
    <p className="runway-caption">Projected balances on {day(data.end)} · UTC</p>
    <dl className="runway-balances">
      {coins.map(coin => <div key={coin}><dt>{coin}</dt>
        <dd>{amount(projection.closing[coin])}</dd>
        <small>{amount(data.opening[coin])} today</small></div>)}
    </dl>
    {included.length > 0 && <>
      {first ? <p className="runway-note short"><strong>{first.token} runs short on {day(first.date)}.</strong>{" "}
        Projected shortfall of {amount(first.amount)} {first.token} that day.</p>
        : tightWeek ? <p className="runway-note tight"><strong>Low buffer the week of {day(tightWeek.from)}.</strong>{" "}
          A coin reaches zero after a payout or has less left than the following week’s payouts.</p>
        : <p className="runway-note">Your current balances cover all included payouts through {day(data.end)}.</p>}
      <table className="runway-weeks">
        <caption>Projected closing balance by week</caption>
        <thead><tr><th scope="col">Dates (UTC)</th><th scope="col">USDT</th><th scope="col">USDC</th></tr></thead>
        <tbody>{projection.weeks.map(week => <tr key={week.from}>
          <th scope="row">{day(week.from)} – {day(week.through)}
            {week.status !== "covered" && <small className={week.status}>{week.status === "short" ? "Shortfall" : "Low buffer"}</small>}</th>
          {coins.map(coin => <td key={coin}>{amount(week.closing[coin])}</td>)}
        </tr>)}</tbody>
      </table>
    </>}
  </>;
}

export function useRunway(mode: "summary" | "forecast" | null) {
  const api = useApi();
  const [data, setData] = useState<RunwayData | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<{ planId: string; included: boolean } | null>(null);
  const sequence = useRef(0);
  const visible = useRef(false);
  const updating = useRef(false);
  const refresh = useCallback(async () => {
    if (!visible.current) return;
    const request = ++sequence.current;
    const result = await api<RunwayData>("runway");
    if (request !== sequence.current) return;
    if (result.ok) {
      setData(result.body);
      setError("");
    } else {
      setData(null);
      setError(result.body.error ?? "Couldn’t load the forecast.");
    }
  }, [api]);

  useEffect(() => {
    visible.current = Boolean(mode);
    if (!mode) {
      setData(null);
      setError("");
      return;
    }
    if (!updating.current) void refresh();
    const timer = setInterval(() => { if (!updating.current) void refresh(); }, 30_000);
    return () => { clearInterval(timer); visible.current = false; sequence.current++; };
  }, [mode, refresh]);

  async function choose(planId: string, included: boolean) {
    if (updating.current) return;
    updating.current = true;
    setSaving({ planId, included });
    sequence.current++;
    try {
      const result = await api("runway/inclusion", { body: { planId, included } });
      await refresh();
      if (!result.ok && visible.current) setError(result.body.error ?? "Couldn’t save your selection.");
    } finally {
      updating.current = false;
      setSaving(null);
    }
  }
  return { data, error, saving, refresh, choose };
}

export function ForecastShortcut({ data, onOpen }: { data: RunwayData | null; onOpen: () => void }) {
  const first = data?.projection?.firstShortfall[0];
  if (!first) return null;
  return <button type="button" className="forecast-shortcut" onClick={onOpen}>
    <strong>{first.token} runs short on {day(first.date)}</strong>
    <span>View forecast <span aria-hidden="true">→</span></span>
  </button>;
}

export function Runway({ runway, onPlan }: { runway: ReturnType<typeof useRunway>; onPlan: () => void }) {
  const { data, error, saving, refresh, choose } = runway;
  return <>
    {error && <p className="error-card" role="alert">{error} <button className="link" onClick={refresh}>Refresh</button></p>}
    {!data && !error && <Skeleton variant="runway" label="Loading balances and dated payouts" />}
    {data && <>
      <div aria-busy={Boolean(saving)}><Forecast data={data} /></div>
      {data.plans.length > 0 ? <details className="runway-plans">
        <summary>Choose payouts <span role="status">{saving ? "Updating forecast…" :
          `${data.plans.filter(p => p.included).length} of ${data.plans.length} plans included`}</span></summary>
        <p className="sub">Select the dated plans you expect to pay. Overdue selections count today.</p>
        {data.plans.map(plan => <label key={plan.id} className="runway-choice">
          <input type="checkbox" checked={saving?.planId === plan.id ? saving.included : plan.included}
            disabled={Boolean(saving)} onChange={e => void choose(plan.id, e.target.checked)} />
          <span><strong>{day(plan.date)}{plan.date < data.today && " · Overdue"}</strong>
            {plan.payments.map((p, i) => <small key={i}>{p.name} · {amount(p.amount)} {p.token}{p.pending && " · Awaiting receipt"}</small>)}</span>
        </label>)}
      </details> : <div className="runway-empty"><p>No upcoming payouts. Give a payment a due date in chat to include it here.</p>
        <button type="button" className="link" onClick={onPlan}>Plan a payout in chat →</button></div>}
      <p className="sub runway-basis">Based on your liquid USDT and USDC and the dated payouts you include. Assumes no new deposits or swaps.</p>
    </>}
  </>;
}
