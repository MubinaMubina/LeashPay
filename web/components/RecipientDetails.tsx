"use client";

import { useEffect, useRef, useState } from "react";
import { encodeFunctionData, formatUnits, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { explorerAddress, shortAddress } from "@/lib/chain";
import { errorText, useApi, useOwnerWallet, useSendAndWait } from "@/lib/client";
import { formatTokenAmount } from "@/lib/plan-progress";
import { readCapForEdit, readRecipientAuthorization, verifyCapReceipt, withVaultLock, type RecipientBook } from "@/lib/recipient-book";
import { CURRENCIES, changeRecipientCap, recipientNameError, type Currency, type DirectoryEntry, type ListedRecipient } from "@/lib/recipients";
import { PaymentList } from "./PaymentHistory";

type Editor =
  | { field: "name"; original: string }
  | { field: "currency"; original?: string; name: string; country?: string }
  | { field: "cap"; original: bigint };

const labels = {
  name: { title: "Edit name", submit: "Save name", saved: "Name saved." },
  currency: { title: "Edit display currency", submit: "Save currency", saved: "Display currency saved." },
  cap: { title: "Edit monthly cap", submit: "Confirm in wallet", saved: "Monthly cap confirmed." },
} as const;

const currencyNames: Record<Currency, string> = {
  VND: "Vietnamese đồng", PHP: "Philippine peso", THB: "Thai baht", USD: "US dollar",
};

function originalValue(edit: Editor) {
  return edit.field === "cap" ? formatUnits(edit.original, 18) : edit.original ?? "";
}

function directoryUpdate(edit: Exclude<Editor, { field: "cap" }>, value: string, owner: string, address: Address) {
  if (edit.field === "name") {
    const name = value.trim();
    const invalid = recipientNameError(name);
    if (invalid) throw new Error(invalid);
    return { path: "directory/rename", body: { owner, address, name, expectedName: edit.original } };
  }
  if (!CURRENCIES.some(currency => currency === value)) throw new Error("Choose a display currency.");
  return { path: "directory", body: {
    owner, address, name: edit.name, country: edit.country, currency: value,
    expectedDetails: { country: edit.country, currency: edit.original },
  } };
}

export function RecipientDetails({ contact, vault, book, onDirectory, onWalletPending, onClose }: {
  contact: DirectoryEntry; vault: Address; book: RecipientBook;
  onDirectory: (entries: DirectoryEntry[]) => void; onWalletPending: (pending: boolean) => void; onClose: () => void;
}) {
  const api = useApi();
  const owner = useOwnerWallet()?.address;
  const sendAndWait = useSendAndWait();
  const dialog = useRef<HTMLDialogElement>(null);
  const working = useRef(false);
  const [authorization, setAuthorization] = useState<ListedRecipient["onChain"]>();
  const [attempt, setAttempt] = useState(0);
  const [edit, setEdit] = useState<Editor | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const nameButton = useRef<HTMLButtonElement>(null);
  const currencyButton = useRef<HTMLButtonElement>(null);
  const capButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Editor["field"] | null>(null);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    let current = true;
    void readRecipientAuthorization(vault, contact.address).then(result => { if (current) setAuthorization(result); });
    return () => { current = false; };
  }, [vault, contact.address, attempt]);

  useEffect(() => {
    if (!edit && returnFocus.current) {
      const buttons = { name: nameButton.current, currency: currencyButton.current, cap: capButton.current };
      (buttons[returnFocus.current] ?? nameButton.current)?.focus();
      returnFocus.current = null;
    }
  }, [edit]);

  function begin(next: Editor) {
    setValue(originalValue(next));
    setError("");
    setNotice("");
    setEdit(next);
  }

  function finish() {
    returnFocus.current = edit?.field ?? null;
    setError("");
    setEdit(null);
  }

  function dismiss() {
    if (working.current) return;
    if (edit) finish();
    else onClose();
  }

  async function save() {
    if (!edit || working.current) return;
    if (!owner) { setError("Your wallet isn’t ready yet."); return; }
    const element = dialog.current!;
    const ensureOpen = () => {
      if (!element.isConnected) throw new Error("The recipient editor has closed.");
    };
    working.current = true;
    setBusy(true);
    setError("");
    try {
      await withVaultLock(vault, async () => {
        ensureOpen();
        if (edit.field !== "cap") {
          const { path, body } = directoryUpdate(edit, value, owner, contact.address);
          const result = await api<DirectoryEntry[]>(path, { body });
          if (edit.field === "name" && result.status === 404) throw new Error("This agent version doesn’t support renaming yet.");
          if (!result.ok) throw new Error(result.body.error || "Couldn’t save the recipient’s details.");
          const saved = Array.isArray(result.body) && result.body.find(entry => entry.address === contact.address);
          if (!saved || saved[edit.field] !== value.trim()) throw new Error("Couldn’t verify the change. Reopen the recipient.");
          if (element.isConnected) onDirectory(result.body);
        } else {
          const updated = await changeRecipientCap(edit.original, value, async () => {
            const result = await readCapForEdit(vault, contact.address, getAddress(owner));
            if (element.isConnected) setAuthorization(result.authorization);
            return result;
          }, async (cap, nonce) => {
            ensureOpen();
            // A native modal makes Privy's wallet portal inert. Give it the top layer
            // until the transaction settles, then return to the same recipient.
            element.close();
            onWalletPending(true);
            try {
              await sendAndWait(vault, encodeFunctionData({
                abi: leashVaultAbi, functionName: "setRecipient", args: [contact.address, true, cap],
              }), { nonce, checkReceipt: receipt => verifyCapReceipt(receipt, vault, contact.address, cap) });
            } finally {
              if (element.isConnected) {
                onWalletPending(false);
                if (element.closest("[hidden]")) onClose();
                else element.showModal();
              }
            }
          });
          if (element.isConnected) setAuthorization(updated);
        }
      });
      if (element.isConnected) {
        setNotice(labels[edit.field].saved);
        finish();
      }
    } catch (err) {
      if (element.isConnected) setError(errorText(err));
    } finally {
      working.current = false;
      book.changed();
      if (element.isConnected) setBusy(false);
    }
  }

  const isCap = edit?.field === "cap";
  function updateValue(next: string) {
    setValue(next);
    setError("");
  }

  const title = edit ? labels[edit.field].title : contact.name;
  return <dialog className="checks-dialog recipient-details" ref={dialog} aria-labelledby="recipient-detail-title"
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <div className="checks-sheet">
      <header><h2 id="recipient-detail-title">{title}</h2>
        {!edit && <div className="contact-actions">
          <button type="button" className="link" ref={nameButton} onClick={() => begin({ field: "name", original: contact.name })}>Edit name</button>
          <button type="button" className="chip" autoFocus onClick={onClose}>Close</button>
        </div>}</header>
      <div className="checks-content">
        {edit ? <form className="add-form contact-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
          <p className="contact-target"><strong>{contact.name}</strong> · <a href={explorerAddress(contact.address)} target="_blank"
            rel="noreferrer">{shortAddress(contact.address)} ↗</a></p>
          {edit.field === "currency" ? <fieldset className="currency-options" disabled={busy}>
            <legend>Display currency</legend>
            {CURRENCIES.map(currency => <label className="currency-choice" key={currency}>
              <input type="radio" name="display-currency" value={currency} checked={value === currency}
                autoFocus={currency === (CURRENCIES.find(code => code === edit.original) ?? CURRENCIES[0])}
                onChange={() => updateValue(currency)} />
              <span><strong>{currency}</strong><small>{currencyNames[currency]}</small></span>
            </label>)}
          </fieldset> : <label>{isCap ? "Monthly cap (USDT or USDC per 30 days)" : "Name"}
            <input autoFocus required maxLength={isCap ? 80 : 60} inputMode={isCap ? "decimal" : "text"} disabled={busy}
              value={value} onChange={event => updateValue(event.target.value)} />
          </label>}
          {edit.field === "cap" && <p className="sub">The current cap is {formatTokenAmount(String(authorization?.monthlyCap ?? edit.original))}.
            {" "}Payments already made this period count toward the new limit.</p>}
          {edit.field === "name" && <p className="sub">Use this name when asking the chat to pay this recipient.</p>}
          {edit.field === "currency" && <p className="sub">
            {value === "USD" ? "New plans show the stablecoin amount alone." : "New plans show an estimate in the selected currency."}
            {" "}Payments settle in USDT or USDC.
          </p>}
          {error && <p className="kill-error" role="alert">{error}</p>}
          <div className="add-actions">
            <button className="btn" type="submit" disabled={busy || value.trim() === originalValue(edit)}>
              {busy ? "Saving…" : labels[edit.field].submit}</button>
            <button className="link" type="button" disabled={busy} onClick={finish}>Cancel</button>
          </div>
        </form> : <>
          {notice && <p className="added contact-notice" role="status">{notice}</p>}
          <dl className="contact-fields">
            <dt>Wallet</dt><dd><a href={explorerAddress(contact.address)} target="_blank" rel="noreferrer"><code>{contact.address}</code> ↗</a></dd>
            {contact.country && <><dt>Country</dt><dd>{contact.country}</dd></>}
            <dt>Display currency</dt><dd>{contact.currency ?? "Not set"}
              <button type="button" className="link edit-currency" ref={currencyButton}
                onClick={() => begin({ field: "currency", original: contact.currency, name: contact.name, country: contact.country })}>Edit currency</button></dd>
            <dt>Monthly cap</dt><dd>{authorization === undefined ? "Checking…" : authorization === null ?
              <>Unavailable <button type="button" className="link" onClick={() => { setAuthorization(undefined); setAttempt(n => n + 1); }}>Retry</button></> :
              authorization.allowed ? <>{formatTokenAmount(String(authorization.monthlyCap))} USDT or USDC per 30 days
                <button type="button" className="link edit-cap" ref={capButton}
                  onClick={() => begin({ field: "cap", original: authorization.monthlyCap })}>Edit cap</button></> : "Not authorized"}</dd>
          </dl>
          <PaymentList key={contact.address} contact={contact} fresh />
        </>}
      </div>
    </div>
  </dialog>;
}
