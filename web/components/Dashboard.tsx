"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { errorText, useApi, useSendAndWait } from "@/lib/client";
import { parseStoredThreshold } from "@/lib/depeg";
import { formatAmount } from "@/lib/plan-progress";
import { Skeleton } from "./Skeleton";
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

const PHONE_QUERY = "(max-width: 799px)";
function subscribeToWidth(notify: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
const readMobile = () => window.matchMedia(PHONE_QUERY).matches;
const serverMobile = () => false;

export function Dashboard({ vault }: { vault: Address }) {
  const mobile = useSyncExternalStore(subscribeToWidth, readMobile, serverMobile);
  const dashboard = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLDialogElement>(null);
  const api = useApi();
  const sendAndWait = useSendAndWait();
  const [info, setInfo] = useState<VaultJson | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [agentDown, setAgentDown] = useState(false);
  const [killSwitch, setKillSwitch] = useState<Switch>({ kind: "idle" });
  const [reaction, setReaction] = useState<"changed" | "unchanged" | null>(null);
  const lastBalance = useRef<string | null>(null);
  const [depegThreshold, setDepegThreshold] = useDepegThreshold(vault);
  const clearReaction = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Some mobile browsers resize only the visual viewport when the keyboard opens.
  useEffect(() => {
    const view = window.visualViewport;
    const element = dashboard.current;
    if (!mobile || !view || !element) return;
    const fit = () => {
      if (view.scale !== 1) return;
      const height = view.offsetTop + view.height - element.getBoundingClientRect().top;
      element.style.setProperty("--visible-height", `${Math.max(0, height)}px`);
    };
    fit();
    view.addEventListener("resize", fit);
    view.addEventListener("scroll", fit);
    return () => {
      view.removeEventListener("resize", fit);
      view.removeEventListener("scroll", fit);
      element.style.removeProperty("--visible-height");
    };
  }, [mobile]);

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
      setVaultError(null);
    } else {
      setVaultError(found.body.error || "Couldn’t refresh the vault.");
      setAgentDown(found.status === 502 && found.body.error === "agent unreachable");
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

  const dailyCap = BigInt(info?.rules.dailyCap ?? 0);
  const spent = info && dailyCap > 0n ? Number((BigInt(info.spentToday) * 1000n) / dailyCap) / 10 : 0;
  const paused = info?.paused ?? false;
  const statusText = vaultError ? "Status unavailable" : !info ? "Loading…" : paused ? "Paused" : "Active";
  const dotClass = `dot ${vaultError || !info ? "unknown" : paused ? "off" : ""}`;
  const status = (
    <span className="status"><i className={dotClass} />{statusText}</span>
  );
  const vaultPanel = (
    <>
      <div className="vault-scroll">
        <div className="vault-title">
          <h2>Your vault</h2>
          {mobile && <button className="sheet-close link" aria-label="Close vault" onClick={() => sheet.current?.close()}>Close</button>}
        </div>
        {status}
        {vaultError && <p className="error-card" role="alert">{vaultError} <button className="link" onClick={refresh}>Retry</button></p>}
        {info ? (
          <>
            <div className="label">Balance</div>
            <div className={`balances balance ${reaction === "changed" ? "flash" : ""}`}>
              {(["USDT", "USDC"] as const).map((coin) => (
                <div className="kv" key={coin}><span>{coin}</span><strong>{formatAmount(info.balances[coin], "").trim()}</strong></div>
              ))}
            </div>
            {reaction === "unchanged" && <div className="unchanged">Balance unchanged · vault refused</div>}
            <div className="spent-line"><span>Spent today</span><span>{formatAmount(info.spentToday, "").trim()} of {formatAmount(info.rules.dailyCap, "").trim()}</span></div>
            <div className="meter" title="Daily spending limit"><i style={{ width: `${Math.min(100, spent)}%` }} /></div>
          </>
        ) : !vaultError && <Skeleton label="Loading balances and spending" />}
        <details className="vault-details">
          <summary>Vault rules</summary>
          <a href={explorerAddress(vault)} target="_blank" rel="noreferrer">{shortAddress(vault)} ↗</a>
          {info && <>
            <div className="kv"><span>Per payment</span><span>{formatAmount(info.rules.perPaymentCap, "USDT")}</span></div>
            <div className="kv"><span>Cooldown</span><span>{info.rules.cooldown} s per person</span></div>
            <div className="kv"><span>Price floor</span><span>${formatAmount(info.rules.minTokenPrice, "").trim()}</span></div>
            <div className="sub">Daily spending resets at 07:00 Bangkok time.</div>
          </>}
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

        </details>
        <details className="vault-details">
          <summary>Recipients</summary>
          <Recipients vault={vault} agent={info ? (info.agent ? getAddress(info.agent) : null) : undefined} />
        </details>
      </div>
      <div className="kill-area">
        <button className={`kill ${paused ? "on" : ""}`} onClick={toggle} disabled={!info || Boolean(vaultError) || killSwitch.kind === "sending"}>
          {killSwitch.kind === "sending" ? "Confirm in your wallet…" : paused ? "Unpause vault" : "Pause vault"}
        </button>
        {killSwitch.kind === "failed" && <p className="kill-error">{killSwitch.error}</p>}
      </div>
    </>
  );

  return (
    <main ref={dashboard} className="dashboard">
      {mobile && <button className="vault-trigger" aria-haspopup="dialog" onClick={() => sheet.current?.showModal()}>
        <span className="status"><i className={dotClass} />Vault {statusText.toLowerCase()}</span><span>View vault ›</span>
      </button>}
      <div className="main-col">
        <h1>Payment chat</h1>
        {agentDown && <div className="banner">The agent isn't running on this laptop. Start it with npm start in agent/.</div>}
        {paused && <div className="banner">Vault paused. The agent can't pay anyone until you unpause. You can still withdraw.</div>}
        <Chat onSettled={onSettled} onAgentDown={() => setAgentDown(true)} depegThreshold={depegThreshold} />
      </div>
      {mobile ? (
        <dialog ref={sheet} className="vault-sheet" aria-label="Your vault"
          onClick={(event) => { if (event.target === sheet.current) sheet.current?.close(); }}>
          <div className="vault-col">{vaultPanel}</div>
        </dialog>
      ) : <aside className="vault-col" aria-label="Your vault">{vaultPanel}</aside>}
    </main>
  );
}
