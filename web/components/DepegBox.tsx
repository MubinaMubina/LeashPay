"use client";

import { percent as pct, readingTime } from "@/lib/depeg";
import type { PlanDepegJson } from "@/lib/plan-progress";

const PREFIX = "Depeg guard: ";

/**
 * The depeg guard on the plan card. Cournot's own reading (the exact claim, its probability,
 * its sources, the live call's time and request id) is shown as Cournot returned it; the coin
 * choice is LeashPay's, and is labeled as ours. Its sentence is the agent's own (`depeg.note`, never
 * searched for among Claude's notes), word for word as the owner signs it.
 */
export function DepegBox({ depeg }: { depeg: PlanDepegJson }) {
  const sentence = depeg.note?.startsWith(PREFIX) ? depeg.note.slice(PREFIX.length) : depeg.note;
  if (!depeg.available) {
    return (
      <div className="depeg off">
        <div className="depeg-head">Depeg check unavailable</div>
        <p>{sentence ?? depeg.reason}</p>
      </div>
    );
  }

  const risk = depeg.probability * 100;
  // The bar spans 0 to twice the limit (at least 10%), so the limit marker sits in the middle.
  const scale = Math.max(10, depeg.threshold * 2);
  const above = depeg.chosenToken === "USDT";

  return (
    <div className={`depeg ${above ? "switch" : ""}`}>
      <div className="depeg-head">
        Depeg check · Cournot
        <span className="depeg-meta">
          reading from {readingTime(depeg.fetchedAt)} · market #{depeg.marketId}
          {depeg.requestId ? ` · request ${depeg.requestId}` : ""}
        </span>
      </div>
      <p className="claim">“{depeg.claim}”</p>
      <div className="risk-row">
        <span className="risk">{pct(depeg.probability)}</span>
        <div className="risk-bar" role="img" aria-label={`Cournot probability ${pct(depeg.probability)}, your limit ${depeg.threshold}%`}>
          <i aria-hidden="true" style={{ width: `${Math.min(100, (risk / scale) * 100)}%` }} />
          <b aria-hidden="true" style={{ left: `${Math.min(100, (depeg.threshold / scale) * 100)}%` }} title={`Your limit: ${depeg.threshold}%`} />
        </div>
      </div>
      {depeg.sources.length > 0 && (
        <ul className="sources">
          {depeg.sources.map((s, i) => (
            <li key={i}>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title} ↗
                </a>
              ) : (
                s.title
              )}
              {s.time && <small> · {new Date(s.time).toLocaleDateString("en-GB")}</small>}
            </li>
          ))}
        </ul>
      )}
      <p className="choice">
        <span className="ours">LeashPay's choice</span>{" "}
        {sentence ?? `${pct(depeg.probability)} is ${above ? "above" : "within"} your ${depeg.threshold}% limit, so LeashPay pays in ${depeg.chosenToken}.`}
      </p>
    </div>
  );
}
