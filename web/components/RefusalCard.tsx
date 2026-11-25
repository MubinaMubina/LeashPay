"use client";

import { explorerTx, shortAddress } from "@/lib/chain";

/** The agent's demo-attack result (agent/src/execution/executor.ts AttackResult). */
export interface AttackResultJson {
  recipient: string;
  hash: string;
  status: "reverted" | "pending" | "succeeded";
  reason: string | null;
  reasonMessage?: string;
  reasonSource: "replay" | "preview" | null;
  block: string | null;
}

const SOURCE_LABEL = {
  replay: "the vault's reason, checked again just after",
  preview: "from the vault check before sending",
} as const;

/**
 * The attack's outcome, never claiming more than the chain shows (D19): "Refused" only for a
 * final reverted transaction; a pending one says so; an unexpected success is shown loudly.
 */
export function RefusalCard({ result, balance }: { result: AttackResultJson; balance: string | null }) {
  const link = (
    <a href={explorerTx(result.hash)} target="_blank" rel="noreferrer">
      See the transaction on BscScan ↗
    </a>
  );

  if (result.status === "pending") {
    return (
      <div className="card attack pending">
        <h4>Still confirming…</h4>
        <p>The agent sent the payment to {shortAddress(result.recipient)}; its block isn't final yet. {link}</p>
      </div>
    );
  }

  if (result.status === "succeeded") {
    return (
      <div className="card attack failed-guard">
        <h4>The vault did NOT refuse this payment</h4>
        <p>This should never happen. Report it with the transaction: {link}</p>
      </div>
    );
  }

  return (
    <div className="card attack refused">
      <h4>Refused by the vault{result.reason ? `: ${result.reason}` : ""}</h4>
      <p>
        {shortAddress(result.recipient)} is not one of your recipients. The agent tried anyway, without your signature,
        and the vault said no.
      </p>
      {result.reasonMessage && (
        <p className="why">
          {result.reasonMessage}
          {result.reasonSource && <em> ({SOURCE_LABEL[result.reasonSource]})</em>}
        </p>
      )}
      <p>
        <b>Funds stayed in the vault{balance ? `: ${balance}` : ""}.</b> {link}
      </p>
    </div>
  );
}
