import { useState } from "react";
import type { Address } from "viem";
import { shortAddress } from "@/lib/chain";
import { formatAmount } from "@/lib/plan-progress";
import type { RecipientBook } from "@/lib/recipient-book";
import { AddRecipientForm } from "./RecipientForm";

export { AddRecipientForm };
export { useRecipientBook, type RecipientBook } from "@/lib/recipient-book";

interface Props {
  vault: Address;
  agent: Address | null | undefined;
  book: RecipientBook;
}

export function Recipients({ vault, agent, book }: Props) {
  const [open, setOpen] = useState(false);
  const [addedName, setAddedName] = useState<string | null>(null);
  const { list, error, refresh } = book;
  const partial = list?.some((entry) => !entry.onChain);
  return (
    <>
      <div className="label">Recipients</div>
      {error && <div className="sub" role="alert">{error}</div>}
      {list === null && !error && <div className="sub">Loading recipients…</div>}
      {list?.length === 0 && <div className="sub">No recipients yet.</div>}
      {list?.map(({ name, address, country, onChain }) => (
        <div className="person" key={address}>
          <span title={address}>{name} <small>{shortAddress(address)}{country && ` · ${country}`}</small></span>
          {onChain === null ? (
            <small>Vault status unavailable</small>
          ) : onChain.allowed ? (
            <small>{formatAmount(onChain.monthlyCap.toString(), "").trim()} / 30 days</small>
          ) : (
            <small className="not-allowed">Not allowed</small>
          )}
        </div>
      ))}
      {(error || partial) && <button className="link" type="button" onClick={() => void refresh()}>Retry reading recipients</button>}
      {addedName && <div className="added" role="status">{addedName} can be paid now.</div>}
      {open ? (
        <AddRecipientForm vault={vault} agent={agent} book={book} onCancel={() => setOpen(false)}
          onAdded={(name) => { setOpen(false); setAddedName(name); }} />
      ) : (
        <button className="link add-link" type="button" onClick={() => { setAddedName(null); setOpen(true); }}>+ Add recipient</button>
      )}
    </>
  );
}
