"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { errorText, useApi, useSendAndWait } from "@/lib/client";
import { parseStoredThreshold } from "@/lib/depeg";
import { formatAmount } from "@/lib/plan-progress";
import { Chat } from "./Chat";
import { Recipients } from "./Recipients";

interface VaultJson {
  vault: string;
  agent: string | null;
  paused: boolean;
  rules: { perPaymentCap: string; dailyCap: string; cooldown: string; minTokenPrice: string };
  spentToday: string;
  balances: { USDT: string; USDC: string; tbillValue: string };
}

type Switch = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; error: string };

/** One saved limit per vault, so a second owner on the same browser doesn't inherit the first one's. */
const thresholdKey = (vault: Address) => `leashpay.depegThreshold.${vault.toLowerCase()}`;
/** Mirrors DEFAULT_THRESHOLD_PERCENT in agent/src/depeg/guard.ts. */
const DEFAULT_THRESHOLD = 5;
const THRESHOLD_MAX = 20;

/**
 * The owner's depeg limit, kept in this browser per vault (it's the agent's policy, not a vault rule).
 * Storage can be blocked (private modes, strict cookie settings): then the limit lives in memory only.
 */
function useDepegThreshold(vault: Address): [number, (value: number) => void] {
  const [value, setValue] = useState(DEFAULT_THRESHOLD);
  useEffect(() => {
    let saved: number | null = null;
    try {
      saved = parseStoredThreshold(window.localStorage.getItem(thresholdKey(vault)), THRESHOLD_MAX);
    } catch {
      // storage blocked: keep the default
    }
    setValue(saved ?? DEFAULT_THRESHOLD);
  }, [vault]);
  const set = useCallback(
    (next: number) => {
      setValue(next);
      try {
        window.localStorage.setItem(thresholdKey(vault), String(next));
      } catch {
        // storage blocked: the limit still applies until the page reloads
      }
    },
    [vault],
  );
  return [value, set];
}

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
  const [depegThreshold, setDepegThreshold] = useDepegThreshold(vault);
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

          <div className="label">Depeg guard · your limit</div>
          <div className="kv">
            <span>Switch away from USDC above</span>
            <span>{depegThreshold}%</span>
          </div>
          <input
            className="slider"
            type="range"
            min={0}
            max={THRESHOLD_MAX}
            step={0.5}
            value={depegThreshold}
            onChange={(e) => setDepegThreshold(Number(e.target.value))}
            aria-label="Depeg limit: switch away from USDC above this risk"
            aria-valuetext={`${depegThreshold}%`}
          />
          <div className="sub">Cournot's USDC depeg risk is checked before each plan. Applies to the next plan you send.</div>

          <Recipients vault={vault} agent={info ? (info.agent ? getAddress(info.agent) : null) : undefined} />
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
        <Chat onSettled={onSettled} onAgentDown={() => setAgentDown(true)} depegThreshold={depegThreshold} />
      </div>
    </div>
  );
}
