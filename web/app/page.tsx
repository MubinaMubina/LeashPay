"use client";

import { usePrivy, useWallets } from "@privy-io/react-auth";
import { explorerAddress, shortAddress } from "@/lib/chain";

/** The owner's Privy embedded wallet: the only wallet that counts as the vault owner. */
function useOwnerWallet() {
  const { wallets } = useWallets();
  return wallets.find((wallet) => wallet.walletClientType === "privy");
}

export default function Home() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const owner = useOwnerWallet();

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
        ) : (
          <section className="card intro">
            <h1>Signed in</h1>
            <p>
              Your wallet <code>{owner.address}</code> is the owner of your LeashPay vault on BSC testnet.
            </p>
          </section>
        )}
      </main>
    </>
  );
}
