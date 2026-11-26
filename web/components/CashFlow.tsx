"use client";

import { useState, type ReactNode } from "react";
import { TabList } from "./TabList";

const views = ["History", "30-day forecast"] as const;
export type CashFlowView = (typeof views)[number];

export function CashFlow({ view, onSelect, history, forecast }: {
  view: CashFlowView;
  onSelect: (view: CashFlowView) => void;
  history: ReactNode;
  forecast: ReactNode;
}) {
  // Keep the filter, loaded receipts and scroll position when comparing past and future.
  const [historyOpened, setHistoryOpened] = useState(view === "History");
  return <>
    <header className="cash-flow-head">
      <h1>Cash flow</h1>
      <TabList names={views} selected={view} onSelect={next => {
        if (next === "History") setHistoryOpened(true);
        onSelect(next);
      }} prefix="cash-" label="Cash flow" className="cash-flow-tabs" />
    </header>
    <div id="cash-panel-0" className="cash-flow-body" role="tabpanel" aria-labelledby="cash-tab-0" tabIndex={0} hidden={view !== "History"}>
      {historyOpened && history}
    </div>
    <div id="cash-panel-1" className="cash-flow-body" role="tabpanel" aria-labelledby="cash-tab-1" tabIndex={0} hidden={view !== "30-day forecast"}>
      {view === "30-day forecast" && forecast}
    </div>
  </>;
}
