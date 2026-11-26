"use client";

import { usePrivy } from "@privy-io/react-auth";
import type { Address } from "viem";
import { Brand } from "@/components/Brand";
import { AccountWorkspace } from "@/components/AccountWorkspace";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { useOwnerWallet } from "@/lib/client";

export default function Home() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const wallet = useOwnerWallet();
  const owner = ready && authenticated ? wallet : undefined;

  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="account">
          <span className="net">BSC testnet</span>
          {authenticated ? (
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
          ) : <button type="button" className="btn header-login" disabled={!ready} onClick={() => login()}>Log in</button>}
        </div>
      </header>

      <AccountWorkspace key={authenticated ? `${user?.id}:${owner?.address.toLowerCase()}` : "visitor"}
        owner={owner ? owner.address as Address : null} guest={ready && !authenticated} login={login} />
    </>
  );
}
