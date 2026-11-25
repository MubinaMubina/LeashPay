"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useState } from "react";
import type { Address } from "viem";
import { Onboarding } from "@/components/Onboarding";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { useOwnerWallet } from "@/lib/client";

export default function Home() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const owner = useOwnerWallet();
  const [vault, setVault] = useState<Address | null>(null);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="mark" aria-hidden>
            L
          </div>
          LeashPay
        </div>
        {authenticated && (
          <div className="account">
            <span>{user?.email?.address}</span>
            {owner && (
              <a href={explorerAddress(owner.address)} target="_blank" rel="noreferrer">
                {shortAddress(owner.address)}
              </a>
            )}
            <span className="net">BSC testnet</span>
            <button className="link" onClick={logout}>
              Log out
            </button>
          </div>
        )}
      </header>

      <main className="center">
        {!ready ? (
          <p className="hint">Loading…</p>
        ) : !authenticated ? (
          <section className="card intro">
            <h1>An AI payments agent on a leash</h1>
            <p>
              The agent plans your payouts. Your vault decides what it may pay: only your recipients, within your
              caps, and only after you sign.
            </p>
            <button className="btn" onClick={login}>
              Log in with email
            </button>
          </section>
        ) : !owner ? (
          <p className="hint">Creating your wallet…</p>
        ) : !vault ? (
          <Onboarding owner={owner.address as Address} onReady={setVault} />
        ) : (
          <section className="card intro">
            <h1>Your vault is ready</h1>
            <p>
              Vault{" "}
              <a href={explorerAddress(vault)} target="_blank" rel="noreferrer">
                {shortAddress(vault)}
              </a>{" "}
              holds test USDT and USDC, and Linh, Marco and Mai are allowed. The chat with the agent comes next.
            </p>
          </section>
        )}
      </main>
    </>
  );
}
