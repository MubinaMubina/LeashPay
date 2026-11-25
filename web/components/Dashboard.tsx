"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { useApi } from "@/lib/client";
import { DEMO_RECIPIENTS } from "@/lib/demo";
import { formatAmount } from "@/lib/plan-progress";
import { Chat } from "./Chat";

interface VaultJson {
  vault: string;
  agent: string | null;
  paused: boolean;
  rules: { perPaymentCap: string; dailyCap: string; cooldown: string; minTokenPrice: string };
  spentToday: string;
  balances: { USDT: string; USDC: string; tbillValue: string };
}

/** The owner's screen: the vault at a glance on the left, the chat with the agent in the middle. */
export function Dashboard({ vault }: { vault: Address }) {
  const api = useApi();
  const [info, setInfo] = useState<VaultJson | null>(null);
  const [agentDown, setAgentDown] = useState(false);

  const refresh = useCallback(async () => {
    const found = await api<VaultJson>("vault");
    if (found.ok) {
      setInfo(found.body);
      setAgentDown(false);
    } else if (found.status === 502 && found.body.error === "agent unreachable") {
      setAgentDown(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const every = setInterval(refresh, 15_000);
    return () => clearInterval(every);
  }, [refresh]);

  const spent = info ? Number(BigInt(info.spentToday) * 1000n / BigInt(info.rules.dailyCap)) / 10 : 0;

  return (
    <div className="dashboard">
      <aside className="vault-col">
        <div className="label">Vault balance</div>
        <div className="balance">{info ? formatAmount(info.balances.USDT, "USDT") : "…"}</div>
        <div className="sub">
          {info ? formatAmount(info.balances.USDC, "USDC") : ""} ·{" "}
          <a href={explorerAddress(vault)} target="_blank" rel="noreferrer">
            {shortAddress(vault)}
          </a>
        </div>

        <div className="label">Spent today</div>
        <div className="meter">
          <i style={{ width: `${Math.min(100, spent)}%` }} />
        </div>
        <div className="kv">
          <span>{info ? `${formatAmount(info.spentToday, "")} of ${formatAmount(info.rules.dailyCap, "USDT")}` : "…"}</span>
          <span>resets 07:00</span>
        </div>

        <div className="label">Your rules · the vault enforces them</div>
        <div className="kv">
          <span>Per payment</span>
          <span>{info ? formatAmount(info.rules.perPaymentCap, "USDT") : "…"}</span>
        </div>
        <div className="kv">
          <span>Cooldown</span>
          <span>{info ? `${info.rules.cooldown} s per person` : "…"}</span>
        </div>
        <div className="kv">
          <span>Price floor</span>
          <span>{info ? `$${formatAmount(info.rules.minTokenPrice, "").trim()}` : "…"}</span>
        </div>

        <div className="label">Recipients</div>
        {DEMO_RECIPIENTS.map((r) => (
          <div className="person" key={r.address}>
            <span>
              {r.name} <small>· {r.country}</small>
            </span>
            <small>{formatAmount(r.monthlyCap.toString(), "")}/ 30 days</small>
          </div>
        ))}

        <div className="label">Status</div>
        <div className="status">
          <span className={`dot ${info?.paused ? "off" : ""}`} />
          {info ? (info.paused ? "Vault paused" : "Agent can pay") : "…"}
        </div>
      </aside>

      <div className="main-col">
        {agentDown && <div className="banner">The agent isn't running on this laptop. Start it with npm start in agent/.</div>}
        <Chat onSettled={refresh} onAgentDown={() => setAgentDown(true)} />
      </div>
    </div>
  );
}
