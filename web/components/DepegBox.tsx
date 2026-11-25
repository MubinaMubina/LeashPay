"use client";

import type { DepegJson } from "@/lib/plan-progress";

const pct = (probability: number) => `${Number((probability * 100).toFixed(2))}%`;

/**
 * The depeg guard on the plan card. Cournot's own reading (the exact claim, its probability,
 * its sources, the live call's time and request id) is shown as Cournot returned it; the coin
 * choice is LeashPay's, and is labeled as ours.
 */
export function DepegBox({ depeg }: { depeg: DepegJson }) {
  if (!depeg.available) {
    return (
      <div className="depeg off">
        <div className="depeg-head">Depeg check unavailable</div>
        <p>{depeg.reason} The plan keeps its coins; the vault's price floor still applies.</p>
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
          live reading at {new Date(depeg.fetchedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · market #{depeg.marketId}
          {depeg.requestId ? ` · request ${depeg.requestId}` : ""}
        </span>
      </div>
      <p className="claim">“{depeg.claim}”</p>
      <div className="risk-row">
        <span className="risk">{pct(depeg.probability)}</span>
        <div className="risk-bar" aria-label={`Cournot probability ${pct(depeg.probability)}, limit ${depeg.threshold}%`}>
          <i style={{ width: `${Math.min(100, (risk / scale) * 100)}%` }} />
          <b style={{ left: `${Math.min(100, (depeg.threshold / scale) * 100)}%` }} title={`Your limit: ${depeg.threshold}%`} />
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
        <span className="ours">LeashPay's choice</span> {pct(depeg.probability)} is {above ? "above" : "within"} your {depeg.threshold}% limit, so
        every payment is in <b>{depeg.chosenToken}</b>.
      </p>
    </div>
  );
}
