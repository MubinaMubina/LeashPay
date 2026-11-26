"use client";

import { useEffect, useId, useState } from "react";
import { MAX_QUOTE_AGE_MS, type FxRates } from "@/lib/fx";
import { readingTime } from "@/lib/depeg";
import { estimateBankTransfer, PREVIEW_FEE_PERCENT } from "@/lib/transfer-estimate";

type Stablecoin = "USDT" | "USDC";
const quantity = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const price = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The amount stays local. One public USD quote covers both coins and both directions. */
function useUsdQuote(enabled: boolean) {
  const [rates, setRates] = useState<FxRates | null>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      setRates(undefined);
      let delay = 30_000;
      try {
        const response = await fetch("/api/fx/USD", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("USD quote unavailable");
        const quote: FxRates = await response.json();
        const remaining = Date.parse(quote.quotedAt) + MAX_QUOTE_AGE_MS - Date.now();
        if (quote.currency !== "USD" || !Number.isFinite(remaining) || remaining <= 0 ||
            ![quote.USDT, quote.USDC].every(rate => Number.isFinite(rate) && rate > 0)) throw new Error("Invalid USD quote");
        if (!controller.signal.aborted) setRates(quote);
        delay = Math.min(5 * 60_000, remaining);
      } catch {
        if (!controller.signal.aborted) setRates(null);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, delay);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled]);
  return rates;
}

export function MoneyActions({ active }: { active: boolean }) {
  const [direction, setDirection] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [coin, setCoin] = useState<Stablecoin>("USDT");
  const dollars = Number(amount);
  const showEstimate = active && dollars > 0;
  const transfer = showEstimate ? estimateBankTransfer(dollars, direction) : null;
  const rates = useUsdQuote(showEstimate);
  const deposit = direction === "deposit";
  const id = useId();
  const bank = "Your bank account";
  const vault = "LeashPay vault";

  return <section className="transfer-card" aria-label="Bank transfer preview">
    <header className="transfer-heading">
      <h2>Bank transfer</h2>
      <span className="transfer-status">Coming soon</span>
    </header>
    <div className="transfer-options" role="group" aria-label="Transfer direction">
      <button type="button" aria-pressed={deposit} onClick={() => setDirection("deposit")}>
        <span aria-hidden="true">↙</span> Add money
      </button>
      <button type="button" aria-pressed={!deposit} onClick={() => setDirection("withdraw")}>
        <span aria-hidden="true">↗</span> Withdraw
      </button>
    </div>
    <div className="transfer-amount">
      <label htmlFor={id}>{deposit ? "Amount to deposit" : "Bank amount to receive"}<span className="sr-only"> in USD</span></label>
      <div className="transfer-value">
        <input id={id} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
          onChange={event => {
            const next = event.target.value.replace(",", ".");
            if (/^\d{0,9}(\.\d{0,2})?$/.test(next)) setAmount(next);
          }} />
        <span>USD</span>
      </div>
    </div>
    {transfer && <section className="transfer-estimate" aria-label="Stablecoin estimate">
      <div className="estimate-heading">
        <span>{deposit ? "Estimated to your vault" : "Estimated from your vault"}</span>
        <div role="group" aria-label="Stablecoin">
          {(["USDT", "USDC"] as const).map(token => <button type="button" key={token} aria-pressed={coin === token}
            onClick={() => setCoin(token)}>{token}</button>)}
        </div>
      </div>
      <output htmlFor={id}>{rates === undefined ? "Getting rate…" : `≈ ${quantity.format(transfer.vaultUsd / (rates?.[coin] ?? 1))} ${coin}`}</output>
      {rates && <p>1 {coin} ≈ ${price.format(rates[coin])} · CoinMarketCap · <time dateTime={rates.quotedAt}>{readingTime(rates.quotedAt)}</time></p>}
      {rates === null && <p>Example at $1 per {coin}. Market rate unavailable.</p>}
      <dl className="transfer-fees">
        <div><dt>Illustrative transfer fee ({PREVIEW_FEE_PERCENT}%)</dt><dd>{transfer.feeUsd > 0 && (deposit ? "−" : "+")}{usd.format(transfer.feeUsd)}</dd></div>
        <div><dt>{deposit ? "Deposit after fee" : "Total from your vault"}</dt><dd>{usd.format(transfer.vaultUsd)}</dd></div>
      </dl>
    </section>}
    <dl className="transfer-route" aria-label="Transfer route">
      <div><dt>From</dt><dd>{deposit ? bank : vault}</dd></div>
      <div><dt>To</dt><dd>{deposit ? vault : bank}</dd></div>
    </dl>
    <footer className="transfer-footer">
      <button type="button" className="btn" disabled>{deposit ? "Deposit by bank transfer" : "Withdraw to bank"}</button>
      <p>Preview only. No money moves.</p>
    </footer>
  </section>;
}
