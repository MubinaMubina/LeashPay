"use client";

import { useId, useState } from "react";

export function MoneyActions() {
  const [action, setAction] = useState<"add" | "withdraw" | null>(null);
  const [method, setMethod] = useState<"bank" | "apple">("bank");
  const preview = useId();

  return (
    <section className="money-actions" aria-label="Deposits and withdrawals">
      <div className="money-buttons">
        <button type="button" className={action === "withdraw" ? "btn money-secondary" : "btn"} aria-expanded={action === "add"} aria-controls={preview}
          onClick={() => setAction(action === "add" ? null : "add")}>Add money</button>
        <button type="button" className={action === "withdraw" ? "btn" : "btn money-secondary"} aria-expanded={action === "withdraw"} aria-controls={preview}
          onClick={() => setAction(action === "withdraw" ? null : "withdraw")}>Withdraw</button>
      </div>
      <div id={preview} hidden={!action}>
        {action && <div className="money-preview">
          <h3>{action === "add" ? "Add money" : "Withdraw to bank"}</h3>
          <p>{action === "add" ? "Choose how you’d like to fund your account." : "Send money to your local bank account."}</p>
          {action === "add" && <label>Payment method
            <select value={method} onChange={(e) => setMethod(e.target.value === "apple" ? "apple" : "bank")}>
              <option value="bank">Bank transfer</option>
              <option value="apple">Apple Pay</option>
            </select>
          </label>}
          <button className="btn wide" type="button" disabled>
            {action === "withdraw" ? "Withdraw to bank" : method === "bank" ? "Add by bank transfer" : "Add with Apple Pay"} · Coming soon
          </button>
          <p className="sub">Preview only. No money moves.</p>
        </div>}
      </div>
    </section>
  );
}
