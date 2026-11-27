import { useEffect, useId, useState } from "react";
import { shortAddress } from "@/lib/chain";
import { authorizedRecipient, canonicalAmount, draftFields, initialRecipient, paymentReviewMessage, type DraftToken } from "@/lib/payment-draft";
import type { RecipientBook } from "@/lib/recipient-book";
import type { ListedRecipient } from "@/lib/recipients";
import { ChatCard } from "./ChatCards";
import styles from "./PaymentDraftCard.module.css";

interface Props {
  book: RecipientBook;
  source: string[];
  candidates?: string[];
  onReview: (message: string) => void;
  onRequest: (message: string) => void;
  onAddRecipient: () => void;
  busy: boolean;
}

const emptyDirectory: ListedRecipient[] = [];

export function PaymentDraftCard({ book, source, candidates, onReview, onRequest, onAddRecipient, busy }: Props) {
  const id = useId();
  const { list, error, refresh } = book;
  const original = source.join("\n");
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<"loading" | "done" | "failed">("loading");
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [newPayment, setNewPayment] = useState(false);
  const [instructions, setInstructions] = useState(original);
  const [editedAmount, setAmount] = useState<string>();
  const [editedToken, setToken] = useState<DraftToken>();
  const [choice, setChoice] = useState<{ address: string; manual: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    setRead("loading");
    void refresh().then(
      () => { if (current) setRead("done"); },
      () => { if (current) setRead("failed"); },
    );
    return () => { current = false; };
  }, [refresh, attempt]);

  const failed = !!error || read === "failed" || (read === "done" && !list);
  const directory = failed ? emptyDirectory : list ?? emptyDirectory;
  const seed = draftFields(newPayment ? [] : source, directory);
  const automatic = initialRecipient(seed?.recipient ?? "", directory, candidates);
  // Remember the first verified match. A later directory rename must never redirect this draft.
  useEffect(() => {
    if (automatic) setChoice(previous => previous ?? { address: automatic, manual: false });
  }, [automatic]);

  const useInstructions = editingInstructions || !seed;
  const amount = editedAmount ?? seed?.amount ?? "";
  const token = editedToken ?? seed?.token ?? "auto";
  const address = choice?.manual ? choice.address : !choice || choice.address === automatic ? automatic : "";
  const options = directory.filter(authorizedRecipient).sort((a, b) => a.name.localeCompare(b.name, "en") || a.address.localeCompare(b.address));
  const selected = options.find(person => person.address === address);
  const substituted = selected && seed?.recipient && selected.name.toLowerCase() !== seed.recipient.toLowerCase()
    && selected.address.toLowerCase() !== seed.recipient.toLowerCase();
  const matches = options.filter(person => candidates?.includes(person.name));
  const unverified = directory.some(person => person.onChain === null);
  const invalidAmount = !!amount.trim() && !canonicalAmount(amount);
  const message = read === "done" && selected ? paymentReviewMessage(selected.address, amount, token, directory) : null;

  function option(person: ListedRecipient) {
    const short = shortAddress(person.address);
    const duplicate = options.some(other => other !== person && other.name === person.name && shortAddress(other.address) === short);
    return <option key={person.address} value={person.address}>{person.name} · {duplicate ? person.address : short}</option>;
  }

  return (
    <ChatCard title="Prepare a payment">
      {useInstructions ? (
        <form className={styles.form} onSubmit={event => {
          event.preventDefault();
          if (!busy && instructions.trim() && instructions.length <= 2000) onRequest(instructions);
        }}>
          <label className={styles.label} htmlFor={id + "-instructions"}>Payment instructions</label>
          <textarea id={id + "-instructions"} className={styles.control} rows={3} maxLength={2000}
            disabled={busy} value={instructions} onFocus={() => setEditingInstructions(true)} onChange={event => setInstructions(event.target.value)} />
          {instructions.length > 2000 && <p className={styles.status} role="status">Keep the instructions within 2,000 characters.</p>}
          <div className={styles.actions}>
            <button className="btn" type="submit" disabled={busy || !instructions.trim() || instructions.length > 2000}>Review payment</button>
            {seed
              ? <button className="link" type="button" disabled={busy} onClick={() => setEditingInstructions(false)}>Back to fields</button>
              : <button className="link" type="button" disabled={busy} onClick={() => {
                setNewPayment(true); setEditingInstructions(false); setAmount(""); setToken("auto"); setChoice(null);
              }}>Start a new single payment</button>}
          </div>
        </form>
      ) : (
        <form className={styles.form} onSubmit={event => {
          event.preventDefault();
          if (!busy && message) onReview(message);
        }}>
          <div className={styles.fieldHeader}>
            <label className={styles.label} htmlFor={id + "-recipient"}>Recipient</label>
            <button className="link" type="button" onClick={onAddRecipient} disabled={busy}>Add recipient</button>
          </div>
          <select id={id + "-recipient"} className={styles.control} value={selected?.address ?? ""}
            disabled={busy || failed || read === "loading" || !options.length} aria-describedby={id + "-recipient-status"}
            onChange={event => setChoice({ address: event.target.value, manual: true })}>
            <option value="">Choose a recipient</option>
            {matches.length ? <>
              <optgroup label="Matching recipients">{matches.map(option)}</optgroup>
              {matches.length < options.length && <optgroup label="Other recipients">{options.filter(person => !matches.includes(person)).map(option)}</optgroup>}
            </> : options.map(option)}
          </select>
          <div className={styles.recipientStatus} id={id + "-recipient-status"} role="status">
            {failed ? "Couldn’t load your recipients." : read === "loading" ? "Checking recipients…"
              : !options.length ? unverified ? "Couldn’t verify any recipients." : "Add an authorized recipient to continue."
              : selected ? <>{substituted && <span>Using {selected.name} in place of “{seed.recipient}”.</span>}<span className={styles.address}>{selected.address}</span></>
              : seed.recipient ? <>Choose a recipient for “{seed.recipient}”.</> : null}
            {!failed && read === "done" && unverified && options.length > 0 && <span>Some recipients could not be verified.</span>}
            {(failed || unverified) && <button className="link" type="button" onClick={() => setAttempt(n => n + 1)}>Retry</button>}
          </div>
          <div className={styles.row}>
            <label className={styles.label}>Amount
              <input className={styles.control} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={40}
                disabled={busy} value={amount} onChange={event => setAmount(event.target.value)} aria-invalid={invalidAmount || undefined}
                aria-describedby={invalidAmount ? id + "-amount-error" : undefined} />
            </label>
            <label className={styles.label}>Token
              <select className={styles.control} value={token} disabled={busy} onChange={event => setToken(event.target.value as DraftToken)}>
                <option value="auto">Automatic</option><option value="USDT">USDT</option><option value="USDC">USDC</option>
              </select>
            </label>
          </div>
          {invalidAmount && <p id={id + "-amount-error"} className={styles.status} role="status">Enter an amount above 0 and up to 1 billion, with at most 18 decimal places. Use a dot for decimals.</p>}
          <div className={styles.actions}>
            <button className="btn" type="submit" disabled={busy || !message}>Review payment</button>
            {original && <button className="link" type="button" disabled={busy} onClick={() => setEditingInstructions(true)}>Edit original instructions</button>}
          </div>
        </form>
      )}
    </ChatCard>
  );
}
