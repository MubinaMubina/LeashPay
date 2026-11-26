"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useState } from "react";
import type { Address } from "viem";
import { Brand } from "@/components/Brand";
import { Skeleton } from "@/components/Skeleton";
import { Dashboard } from "@/components/Dashboard";
import { Onboarding } from "@/components/Onboarding";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { useOwnerWallet } from "@/lib/client";

function OwnerWorkspace({ owner }: { owner: Address }) {
  const [vault, setVault] = useState<Address | null>(null);
  if (vault) return <Dashboard key={vault} owner={owner} vault={vault} />;
  return <Onboarding owner={owner} onReady={setVault} />;
}

export default function Home() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const owner = useOwnerWallet();

  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="account">
          <span className="net">BSC testnet</span>
          {authenticated && (
            <>
              <button className="avatar" popoverTarget="owner-menu" aria-label="Account menu">
                {user?.email?.address?.slice(0, 1).toUpperCase() || "L"}
              </button>
              <div popover="auto" id="owner-menu" className="account-menu">
                {user?.email?.address && <span>{user.email.address}</span>}
                {owner && <a href={explorerAddress(owner.address)} target="_blank" rel="noreferrer">{shortAddress(owner.address)} ↗</a>}
                <button className="link" onClick={logout}>Log out</button>
              </div>
            </>
          )}
        </div>
      </header>

      {ready && authenticated && owner ? (
        <OwnerWorkspace key={`${user?.id}:${owner.address.toLowerCase()}`} owner={owner.address as Address} />
      ) : (
        <main className="center">
          {!ready ? (
            <Skeleton label="Loading LeashPay" variant="intro" />
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
          ) : (
            <Skeleton label="Creating your wallet" variant="intro" />
          )}
        </main>
      )}
    </>
  );
}
