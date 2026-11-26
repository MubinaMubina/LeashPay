"use client";

import { useId, useState } from "react";

export function MoneyActions() {
  const [direction, setDirection] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
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
      <label htmlFor={id}>Preview amount<span className="sr-only"> in USD</span></label>
      <div className="transfer-value">
        <input id={id} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount}
          onChange={event => {
            const next = event.target.value.replace(",", ".");
            if (/^\d{0,9}(\.\d{0,2})?$/.test(next)) setAmount(next);
          }} />
        <span>USD</span>
      </div>
    </div>
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
