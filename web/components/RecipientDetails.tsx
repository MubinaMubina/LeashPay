"use client";

import { useEffect, useRef } from "react";
import { explorerAddress } from "@/lib/chain";
import { formatTokenAmount } from "@/lib/plan-progress";
import type { DirectoryEntry, ListedRecipient } from "@/lib/recipients";
import { PaymentList } from "./PaymentHistory";

export function RecipientDetails({ contact, authorization, onClose }: {
  contact: DirectoryEntry; authorization: ListedRecipient["onChain"] | undefined; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); };
  }, []);
  return <dialog className="checks-dialog recipient-details" ref={dialog} aria-labelledby="recipient-detail-title"
    onClose={e => { if (!e.currentTarget.open) onClose(); }}
    onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
    <div className="checks-sheet">
      <header><h2 id="recipient-detail-title">{contact.name}</h2>
        <button type="button" className="chip" autoFocus onClick={() => dialog.current?.close()}>Close</button></header>
      <div className="checks-content">
        <dl className="contact-fields">
          <dt>Wallet</dt><dd><a href={explorerAddress(contact.address)} target="_blank" rel="noreferrer"><code>{contact.address}</code> ↗</a></dd>
          {contact.country && <><dt>Country</dt><dd>{contact.country}</dd></>}
          {contact.currency && <><dt>Preferred currency</dt><dd>{contact.currency}</dd></>}
          <dt>Monthly cap</dt><dd>{authorization === undefined ? "Checking…" : !authorization ? "Unavailable" :
            authorization.allowed ? `${formatTokenAmount(String(authorization.monthlyCap))} USDT or USDC per 30 days` : "Not authorized"}</dd>
        </dl>
        <PaymentList key={contact.address} contact={contact} fresh />
      </div>
    </div>
  </dialog>;
}
