import { useEffect, useRef, useState } from "react";
import { encodeFunctionData, formatUnits, getAddress, type Address } from "viem";
import { leashVaultAbi } from "@/lib/abi.generated";
import { errorText, useApi, useOwnerWallet, useSendAndWait } from "@/lib/client";
import { readRecipientAuthorization, type RecipientBook } from "@/lib/recipient-book";
import { CURRENCIES, reviewRecipient, saveReviewedRecipient, type RecipientForm, type RecipientReview } from "@/lib/recipients";

const EMPTY: RecipientForm = { name: "", address: "", country: "", currency: "VND", monthlyCap: "1000" };
const pendingVaults = new Set<string>();

/** Hold the lock through confirmation and the directory save. Web Locks also cover other tabs. */
async function withVaultLock<T>(vault: Address, action: () => Promise<T>): Promise<T> {
  const key = `leashpay.recipient.${vault.toLowerCase()}`;
  const busy = "Another recipient change is in progress for this vault. Try again once it finishes.";
  if (navigator.locks) {
    return navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error(busy);
      return action();
    });
  }
  if (pendingVaults.has(key)) throw new Error(busy);
  pendingVaults.add(key);
  try {
    return await action();
  } finally {
    pendingVaults.delete(key);
  }
}

interface Props {
  vault: Address;
  agent: Address | null | undefined;
  book: RecipientBook;
  initial?: Partial<RecipientForm>;
  onCancel: () => void;
  onAdded: (name: string) => void;
}

export function AddRecipientForm({ vault, agent, book, initial, onCancel, onAdded }: Props) {
  const api = useApi();
  const owner = useOwnerWallet()?.address;
  const sendAndWait = useSendAndWait();
  const [form, setForm] = useState<RecipientForm>(() => ({
    name: initial?.name ?? EMPTY.name,
    address: initial?.address ?? EMPTY.address,
    country: initial?.country ?? EMPTY.country,
    currency: initial?.currency ?? EMPTY.currency,
    monthlyCap: initial?.monthlyCap ?? EMPTY.monthlyCap,
  }));
  const [review, setReview] = useState<RecipientReview | null>(null);
  const [retryName, setRetryName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function submit() {
    if (working.current) return;
    if (!owner) return setError("Your wallet isn't ready yet.");
    if (agent === undefined) return setError("Still reading your vault. Try again in a moment.");
    working.current = true;
    setBusy("Checking…");
    setError(null);
    function ensureOpen() {
      if (!mounted.current) throw new Error("The recipient form has closed.");
    }
    try {
      const reserved = { owner: getAddress(owner), vault, agent };
      const inspect = () => reviewRecipient(form, reserved, {
        directory: book.refresh,
        authorization: (address) => readRecipientAuthorization(vault, address),
      });
      if (!review) {
        const next = await inspect();
        if (mounted.current) setReview(next);
        return;
      }
      const result = await withVaultLock(vault, () => saveReviewedRecipient(review, inspect, {
        authorize: async (recipient) => {
          ensureOpen();
          setBusy("Confirm in your wallet…");
          await sendAndWait(vault, encodeFunctionData({
            abi: leashVaultAbi, functionName: "setRecipient", args: [recipient.address, true, recipient.monthlyCap],
          }));
        },
        saveName: async ({ name, address, country, currency }) => {
          ensureOpen();
          setBusy("Saving the name…");
          const saved = await api("directory", { body: { name, address, country, currency, owner, createOnly: true } });
          if (!saved.ok) throw new Error(saved.body.error ?? `The agent answered ${saved.status}.`);
        },
      }));
      if (!mounted.current) return;
      if (result.kind === "added") {
        await book.refresh();
        if (mounted.current) onAdded(review.recipient.name);
      } else {
        setReview(result.review);
        setRetryName(result.kind === "retry-name");
        setError(result.kind === "retry-name"
          ? `Your vault authorization was confirmed. Saving the name needs another check. ${result.error}`
          : "The vault or directory changed. Review the current details before continuing.");
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const field = (key: keyof RecipientForm) => ({
    value: form[key],
    disabled: Boolean(busy),
    onChange: (e: { target: { value: string } }) => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
      setError(null);
    },
  });
  function edit() {
    setReview(null);
    setRetryName(false);
    setError(null);
  }

  const submitLabel = !review ? "Review recipient" : retryName ? "Retry saving name" : {
    authorize: "Confirm in wallet", "save-name": "Save name", done: "Done",
  }[review.action];

  return (
    <form className="add-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {review ? (
        <div className="recipient-review">
          <strong>{review.recipient.name}</strong>
          <p style={{ overflowWrap: "anywhere" }}>{review.recipient.address}</p>
          <p>{formatUnits(review.recipient.monthlyCap, 18)} USDT or USDC per 30 days</p>
          {review.action === "authorize" && <p className="sub">
            {review.allowed
              ? `The current cap is ${formatUnits(review.currentCap, 18)}. Your wallet will sign the cap change.`
              : "Your wallet will sign to allow payments to this address."}
          </p>}
          {review.action === "save-name" && <p className="sub">Your vault already allows this address at this cap. Save the name to your directory.</p>}
          {review.action === "done" && <p className="sub">This name and address are already in your directory with this vault cap.</p>}
        </div>
      ) : (
        <>
          <label>Name<input {...field("name")} placeholder="Ramon" maxLength={60} /></label>
          <label>Wallet address<input {...field("address")} placeholder="0x…" spellCheck={false} autoComplete="off" /></label>
          <div className="add-row">
            <label>Country<input {...field("country")} placeholder="PH" maxLength={60} /></label>
            <label>Currency<select {...field("currency")}>
              {CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}
            </select></label>
          </div>
          <label>Monthly cap (USDT or USDC per 30 days)<input {...field("monthlyCap")} inputMode="decimal" /></label>
        </>
      )}
      {error && <p className="kill-error" role="alert">{error}</p>}
      <div className="add-actions">
        <button className="btn" type="submit" disabled={Boolean(busy)}>{busy ?? submitLabel}</button>
        {review && <button className="link" type="button" disabled={Boolean(busy)} onClick={edit}>Edit</button>}
        <button className="link" type="button" disabled={Boolean(busy)} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
