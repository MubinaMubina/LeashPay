"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { errorText, useApi, useSendAndWait } from "@/lib/client";
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

type Switch = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; error: string };

/** How long the vault column shows a reaction (balance changed, or "unchanged" after an attack). */
const REACTION_MS = 4_000;

/**
 * The owner's screen: the vault at a glance on the left, the chat in the middle. The kill
 * switch is the owner's own transaction (pause/unpause from the Privy wallet); the agent's
 * key can't unpause. The column reacts to what the chat does, so the jury sees the chat and
 * the vault as one machine.
 */
export function Dashboard({ vault }: { vault: Address }) {
  const api = useApi();
  const sendAndWait = useSendAndWait();
  const [info, setInfo] = useState<VaultJson | null>(null);
  const [agentDown, setAgentDown] = useState(false);
  const [killSwitch, setKillSwitch] = useState<Switch>({ kind: "idle" });
  const [reaction, setReaction] = useState<"changed" | "unchanged" | null>(null);
  const lastBalance = useRef<string | null>(null);
  const clearReaction = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const react = useCallback((kind: "changed" | "unchanged") => {
    setReaction(kind);
    clearTimeout(clearReaction.current);
    clearReaction.current = setTimeout(() => setReaction(null), REACTION_MS);
  }, []);

  const refresh = useCallback(async () => {
    const found = await api<VaultJson>("vault");
    if (found.ok) {
      const balance = found.body.balances.USDT;
      if (lastBalance.current !== null && lastBalance.current !== balance) react("changed");
      lastBalance.current = balance;
      setInfo(found.body);
      setAgentDown(false);
    } else if (found.status === 502 && found.body.error === "agent unreachable") {
      setAgentDown(true);
    }
  }, [api, react]);

  useEffect(() => {
    void refresh();
    const every = setInterval(refresh, 15_000);
    return () => clearInterval(every);
  }, [refresh]);

  const onSettled = useCallback(
    async (outcome?: { attackRefused?: boolean }) => {
      await refresh();
      if (outcome?.attackRefused) react("unchanged");
    },
    [refresh, react],
  );

  const toggle = useCallback(async () => {
    if (!info) return;
    setKillSwitch({ kind: "sending" });
    try {
      const functionName = info.paused ? "unpause" : "pause";
      await sendAndWait(vault, encodeFunctionData({ abi: leashVaultAbi, functionName }));
      setKillSwitch({ kind: "idle" });
      await refresh();
    } catch (err) {
      setKillSwitch({ kind: "failed", error: errorText(err) });
    }
  }, [info, sendAndWait, vault, refresh]);

  const spent = info ? Number((BigInt(info.spentToday) * 1000n) / BigInt(info.rules.dailyCap)) / 10 : 0;
  const paused = info?.paused ?? false;

  return (
    <div className="dashboard">
      <aside className="vault-col">
        <div className="vault-scroll">
          <div className="label">Vault balance</div>
          <div className={`balance ${reaction === "changed" ? "flash" : ""}`}>{info ? formatAmount(info.balances.USDT, "USDT") : "…"}</div>
          {reaction === "unchanged" && <div className="unchanged">🔒 unchanged: the vault refused</div>}
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
            <span>{info ? `${formatAmount(info.spentToday, "").trim()} of ${formatAmount(info.rules.dailyCap, "USDT")}` : "…"}</span>
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
              <small>{formatAmount(r.monthlyCap.toString(), "").trim()} / 30 days</small>
            </div>
          ))}
        </div>

        {/* Pinned to the bottom so it is never scrolled away. */}
        <div className="kill-area">
          <div className="status">
            <span className={`dot ${paused ? "off" : ""}`} />
            {info ? (paused ? "Vault paused" : "Agent can pay") : "…"}
          </div>
          <button className={`kill ${paused ? "on" : ""}`} onClick={toggle} disabled={!info || killSwitch.kind === "sending"}>
            {killSwitch.kind === "sending" ? "Confirm in your wallet…" : paused ? "Unpause vault" : "Pause vault (kill switch)"}
          </button>
          {killSwitch.kind === "failed" && <p className="kill-error">{killSwitch.error}</p>}
        </div>
      </aside>

      <div className="main-col">
        {agentDown && <div className="banner">The agent isn't running on this laptop. Start it with npm start in agent/.</div>}
        {paused && <div className="banner">Vault paused. The agent can't pay anyone until you unpause. You can still withdraw.</div>}
        <Chat onSettled={onSettled} onAgentDown={() => setAgentDown(true)} />
      </div>
    </div>
  );
}
