"use client";

import { Skeleton } from "./Skeleton";
import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, zeroAddress, type Address } from "viem";
import { FACTORY_ADDRESS, explorerAddress, shortAddress } from "@/lib/chain";
import { errorText, publicClient, useSendAndWait } from "@/lib/client";
import { DEMO_RULES } from "@/lib/demo";
import { faucetTokenAbi, leashVaultFactoryAbi } from "@/lib/abi.generated";
import { describeStep, planOnboarding, type OnboardingState, type OnboardingStep } from "@/lib/onboarding";

/** Setup depends only on the owner's vault and its test-token balances. */
async function readState(owner: Address): Promise<OnboardingState> {
  const vault = await publicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: leashVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner],
  });
  if (vault === zeroAddress) {
    return { vault: null, balances: { USDT: 0n, USDC: 0n } };
  }
  const config = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: leashVaultFactoryAbi, functionName: "config" });
  const [usdt, usdc] = await Promise.all([
    publicClient.readContract({ address: config.usdt, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    publicClient.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  ]);
  return { vault, balances: { USDT: usdt, USDC: usdc } };
}

type Phase = { kind: "checking" } | { kind: "ready"; steps: OnboardingStep[] } | { kind: "running"; step: OnboardingStep } | { kind: "failed"; error: string };

/**
 * Vault setup (D10): reads what exists, shows what's missing, and finishes only that.
 * Re-running is always safe, so "Finish setup" after an interruption just continues.
 */
export function Onboarding({ owner, onReady }: { owner: Address; onReady: (vault: Address) => void }) {
  const sendAndWait = useSendAndWait();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [vault, setVault] = useState<Address | null>(null);

  const load = useCallback(async (): Promise<OnboardingState> => {
    const state = await readState(owner);
    setVault(state.vault);
    return state;
  }, [owner]);

  const refresh = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const state = await load();
      const steps = planOnboarding(state);
      if (steps.length === 0 && state.vault) onReady(state.vault);
      else setPhase({ kind: "ready", steps });
    } catch (err) {
      setPhase({ kind: "failed", error: errorText(err) });
    }
  }, [load, onReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async () => {
    try {
      // Re-read before every step: each pass does only what is still missing.
      for (let pass = 0; pass < 20; pass++) {
        const state = await load();
        const [step] = planOnboarding(state);
        if (!step) {
          if (state.vault) onReady(state.vault);
          return;
        }
        setPhase({ kind: "running", step });
        await runStep(step, state.vault);
      }
      throw new Error("Setup didn't finish after 20 steps. Reload the page and try again.");
    } catch (err) {
      setPhase({ kind: "failed", error: errorText(err) });
    }

    async function runStep(step: OnboardingStep, current: Address | null) {
      if (step.kind === "createVault") {
        await sendAndWait(FACTORY_ADDRESS, encodeFunctionData({ abi: leashVaultFactoryAbi, functionName: "createVault", args: [DEMO_RULES] }));
        return;
      }
      if (!current) throw new Error("The vault isn't there yet.");
      const config = await publicClient.readContract({ address: FACTORY_ADDRESS, abi: leashVaultFactoryAbi, functionName: "config" });
      const token = step.coin === "USDT" ? config.usdt : config.usdc;
      await sendAndWait(token, encodeFunctionData({ abi: faucetTokenAbi, functionName: "mint", args: [current, step.amount] }));
    }
  }, [load, onReady, sendAndWait]);

  return (
    <section className="card setup">
      <h1>{vault ? "Finish setting up your vault" : "Set up your vault"}</h1>
      <p className="hint">
        Your vault holds the money and enforces your rules: only your recipients, at most 500 USDT per payment and 20,000 a
        day, one minute between payments to the same person. The agent can ask; the vault decides.
        {vault && (
          <>
            {" "}
            Vault:{" "}
            <a href={explorerAddress(vault)} target="_blank" rel="noreferrer">
              {shortAddress(vault)}
            </a>
          </>
        )}
      </p>

      {phase.kind === "checking" && <Skeleton label="Checking your vault setup" />}

      {phase.kind === "ready" && (
        <>
          <ol className="steps">
            {phase.steps.map((step, i) => (
              <li key={i}>{describeStep(step)}</li>
            ))}
          </ol>
          <button className="btn" onClick={run}>
            {vault ? "Finish setup" : "Set up my vault"}
          </button>
          <p className="hint small">Your wallet confirms vault creation and test funding on BSC testnet. You can add recipients later.</p>
        </>
      )}

      {phase.kind === "running" && <p className="busy">{describeStep(phase.step)}…</p>}

      {phase.kind === "failed" && (
        <div className="error-card">
          <p>{phase.error}</p>
          <button className="btn" onClick={refresh}>
            Check again
          </button>
        </div>
      )}
    </section>
  );
}
