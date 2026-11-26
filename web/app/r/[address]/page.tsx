"use client";

import { Brand } from "@/components/Brand";
import { Skeleton } from "@/components/Skeleton";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { explorerTx, shortAddress } from "@/lib/chain";
import { DEMO_RECIPIENTS } from "@/lib/demo";
import { readingTime } from "@/lib/depeg";
import { FX_CURRENCIES, type FxRates } from "@/lib/fx";
import { formatAmount, formatLocal } from "@/lib/plan-progress";
import { formatUnits } from "viem";
import type { ReceivedPayment } from "@/lib/recipient-logs";

// The two stablecoins of the chain 97 deployment (contracts/deployments/97.json).
const TOKENS: Record<string, string> = {
  "0x0081297d056308340e5501b5f2f076344a46ab44": "USDT",
  "0xadbbbc9a09f258e6d0184d0d5edb0688db15f421": "USDC",
};

type Load = { kind: "loading" } | { kind: "ready"; payments: ReceivedPayment[] } | { kind: "failed"; error: string };

/** The recipient's phone page: what they were paid, from any LeashPay vault. No login: payments are public on-chain. */
export default function RecipientPage() {
  const { address } = useParams<{ address: string }>();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [cashOut, setCashOut] = useState(false);
  const known = DEMO_RECIPIENTS.find((r) => r.address.toLowerCase() === address.toLowerCase());
  const currency = known && (FX_CURRENCIES as readonly string[]).includes(known.currency) ? known.currency : null;
  const [rates, setRates] = useState<FxRates | null>(null);

  // Today's value in the recipient's currency. Optional: without it the page still shows the coin amounts.
  useEffect(() => {
    if (!currency) return;
    let live = true;
    fetch(`/api/fx/${currency}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as FxRates) : null))
      .then((body) => live && setRates(body))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [currency]);

  const localValue = (p: ReceivedPayment) => {
    const token = TOKENS[p.token.toLowerCase()] as "USDT" | "USDC" | undefined;
    if (!rates || !token) return null;
    const rate = rates[token];
    return formatLocal({ currency: rates.currency, amount: Number(formatUnits(BigInt(p.amount), 18)) * rate, rate, quotedAt: rates.quotedAt, source: "CoinMarketCap" });
  };

  const fetchPayments = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const response = await fetch(`/api/recipient/${encodeURIComponent(address)}`, { cache: "no-store" });
      const body = (await response.json()) as { payments?: ReceivedPayment[]; error?: string };
      if (response.ok && body.payments) setLoad({ kind: "ready", payments: body.payments });
      else setLoad({ kind: "failed", error: body.error ?? "Couldn't reach BSC testnet. Try again." });
    } catch {
      setLoad({ kind: "failed", error: "Couldn't reach BSC testnet. Try again." });
    }
  }, [address]);

  useEffect(() => {
    void fetchPayments();
  }, [fetchPayments]);

  return (
    <main className="phone">
      <header className="phone-head">
        <Brand />
        <span className="net">BSC testnet</span>
      </header>

      <h1>{known ? `Hi ${known.name}` : "Payments received"}</h1>
      <p className="hint">{shortAddress(address)}</p>

      {load.kind === "loading" && <Skeleton label="Looking up your payments" variant="receipt" />}

      {load.kind === "failed" && (
        <div className="error-card">
          <p>{load.error}</p>
          <button className="btn" onClick={fetchPayments}>
            Try again
          </button>
        </div>
      )}

      {load.kind === "ready" && load.payments.length === 0 && <p className="hint">No payments yet.</p>}

      {load.kind === "ready" &&
        load.payments.map((p) => (
          <div className="card received" key={`${p.hash}:${p.logIndex}`}>
            <div className="received-amount">{formatAmount(p.amount, TOKENS[p.token.toLowerCase()] ?? "tokens")}</div>
            {localValue(p) && <div className="received-local">{localValue(p)} today</div>}
            <div className="hint small">
              {p.timestamp ? new Date(p.timestamp * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : `block ${p.block}`} ·
              from vault {shortAddress(p.vault)}
            </div>
            <a href={explorerTx(p.hash)} target="_blank" rel="noreferrer">
              View on BscScan ↗
            </a>
          </div>
        ))}

      {load.kind === "ready" && load.payments.length > 0 && rates && (
        <p className="hint small">Today&apos;s value: CoinMarketCap rate from {readingTime(rates.quotedAt)}.</p>
      )}

      {load.kind === "ready" && load.payments.length > 0 && (
        <>
          <button className="btn wide" onClick={() => setCashOut(true)}>
            Cash out{known ? ` to ${known.currency}` : ""}
          </button>
          {cashOut && <p className="hint small">Cash out to a local bank isn't part of the testnet demo.</p>}
        </>
      )}
    </main>
  );
}
