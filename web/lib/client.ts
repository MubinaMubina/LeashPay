"use client";

import { usePrivy, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useCallback } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { chain } from "./chain";

/** Read-only chain access from the browser (eth_call works on the public RPC; log search doesn't). */
export const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 500 });

/** The owner's Privy embedded wallet: the only wallet that counts as the vault owner. */
export function useOwnerWallet() {
  const { wallets } = useWallets();
  return wallets.find((wallet) => wallet.walletClientType === "privy");
}

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T & { error?: string };
}

/** Calls this app's own /api routes with the Privy login token; the server works out the owner. */
export function useApi() {
  const { getAccessToken } = usePrivy();
  return useCallback(
    async <T = unknown>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<ApiResult<T>> => {
      let response: Response;
      try {
        const token = await getAccessToken();
        response = await fetch(`/api/${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: {
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          cache: "no-store",
        });
      } catch {
        return { status: 0, ok: false, body: { error: "The web app's server isn't reachable." } as T & { error: string } };
      }
      const body = (await response.json().catch(() => ({}))) as T & { error?: string };
      return { status: response.status, ok: response.ok, body };
    },
    [getAccessToken],
  );
}

/** Sends a transaction from the owner's wallet (Privy shows its confirmation) and waits for it to succeed. */
export function useSendAndWait() {
  const { sendTransaction } = useSendTransaction();
  const owner = useOwnerWallet();
  return useCallback(
    async (to: Address, data: Hex): Promise<Hex> => {
      if (!owner) throw new Error("Your wallet isn't ready yet.");
      const { hash } = await sendTransaction({ to, data, chainId: chain.id }, { address: owner.address });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== "success") throw new Error(`The transaction failed on-chain: ${hash}`);
      return hash;
    },
    [sendTransaction, owner],
  );
}

/** A readable message from anything thrown by Privy, viem or fetch. */
export function errorText(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") return err.shortMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}
