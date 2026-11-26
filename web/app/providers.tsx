"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";
import { chain } from "@/lib/chain";

/**
 * Privy: email login, and an embedded wallet created on first login. That wallet is
 * the vault owner: it creates the vault, allowlists recipients and signs each plan.
 */
export function Providers({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    return (
      <main className="setup-error">
        <h1>LeashPay needs one setting</h1>
        <p>
          Add <code>NEXT_PUBLIC_PRIVY_APP_ID</code> to the <code>.env</code> file at the root of the repository,
          then restart <code>npm run dev</code> in <code>web/</code>.
        </p>
      </main>
    );
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: chain,
        supportedChains: [chain],
        appearance: {
          theme: "#FFFDF7",
          accentColor: "#191A17",
          logo: <img src="/icon.svg" alt="LeashPay" width={48} height={48} />,
          landingHeader: "Sign in to LeashPay",
          loginMessage: "Enter your email to get a sign-in code.",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
