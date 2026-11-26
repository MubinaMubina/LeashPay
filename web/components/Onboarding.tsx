"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { errorText, useSendAndWait } from "@/lib/client";
import { activatePaymentVault, readOwnerVault } from "@/lib/onboarding";
import { MoneyActions } from "./MoneyActions";

type Phase = "checking" | "empty" | "unavailable" | "activating";

export function Onboarding({ owner, onReady }: { owner: Address; onReady: (vault: Address) => void }) {
  const sendAndWait = useSendAndWait();
  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const activating = useRef(false);

  useEffect(() => {
    let current = true;
    void readOwnerVault(owner).then(vault => {
      if (!current) return;
      if (vault) onReady(vault);
      else setPhase("empty");
    }).catch(() => {
      if (current) setPhase("unavailable");
    });
    return () => { current = false; };
  }, [owner, onReady, attempt]);

  async function activate() {
    if (activating.current) return;
    activating.current = true;
    setPhase("activating");
    setMessage("");
    try {
      onReady(await activatePaymentVault(owner, sendAndWait));
    } catch (err) {
      setMessage(errorText(err));
      // A receipt can arrive after a wallet timeout. Look up the vault before offering another activation.
      setPhase("checking");
      setAttempt(n => n + 1);
    } finally {
      activating.current = false;
    }
  }

  const empty = phase === "empty" || phase === "activating";
  return (
    <main className="account-home">
      <h1>Your account</h1>
      <div className="account-grid">
        <section className="card account-balance" aria-label="Payment balance">
          <h2>Payment balance</h2>
          {empty ? <div className="balances">
            <div className="kv"><span>USDT</span><strong>0</strong></div>
            <div className="kv"><span>USDC</span><strong>0</strong></div>
          </div> : <p className="hint" role="status">{phase === "checking" ? "Checking your balance…" : "Balance unavailable."}</p>}
          <MoneyActions />
        </section>
        <section className="card account-payments">
          <h2>International payments</h2>
          {phase === "unavailable" ? <>
            <p role="alert">We couldn’t check your payment vault. Your account is still open.</p>
            <button className="btn money-secondary" onClick={() => { setPhase("checking"); setAttempt(n => n + 1); }}>Check again</button>
          </> : <>
            <p>When you’re ready to pay someone, create a vault to manage your recipients and spending limits.</p>
            <button className="btn money-secondary" disabled={phase !== "empty"} onClick={activate}>
              {phase === "activating" ? "Opening your vault…" : "Enable payments"}
            </button>
            <p className="sub">Creating a vault costs a small BSC testnet network fee in tBNB.</p>
            {message && <p className="activation-message" role="alert">{message}</p>}
          </>}
        </section>
      </div>
    </main>
  );
}
