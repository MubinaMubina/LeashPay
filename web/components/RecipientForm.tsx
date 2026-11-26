import { createContext, useContext, useEffect, useRef, useState } from "react";
import { formatUnits, getAddress, isAddressEqual, type Address } from "viem";
import { errorText, useApi, useOwnerWallet } from "@/lib/client";
import { readRecipientAuthorization, withVaultLock, type RecipientBook } from "@/lib/recipient-book";
import { CURRENCIES, reviewRecipient, saveReviewedRecipient, type RecipientForm, type RecipientReview } from "@/lib/recipients";
import type { recipientAuthorizationFor } from "@/lib/sponsorship";

export const RecipientAuthorizationContext = createContext<ReturnType<typeof recipientAuthorizationFor> | null>(null);

const EMPTY: RecipientForm = { name: "", address: "", country: "", currency: "VND", monthlyCap: "1000" };
interface Props {
  vault: Address;
  agent: Address | null | undefined;
  book: RecipientBook;
  initial?: Partial<RecipientForm>;
  onBusyChange?: (busy: boolean) => void;
  onCancel: () => void;
  onAdded: (name: string) => void;
}

export function AddRecipientForm({ vault, agent, book, initial, onBusyChange, onCancel, onAdded }: Props) {
  const api = useApi();
  const owner = useOwnerWallet()?.address;
  const authorization = useContext(RecipientAuthorizationContext);
  const sponsored = authorization?.sponsored;
  const [form, setForm] = useState<RecipientForm>(() => ({
    name: initial?.name ?? EMPTY.name,
    address: initial?.address ?? EMPTY.address,
    country: initial?.country ?? EMPTY.country,
    currency: initial?.currency ?? EMPTY.currency,
    monthlyCap: initial ? initial.monthlyCap ?? "" : EMPTY.monthlyCap,
  }));
  const [review, setReview] = useState<RecipientReview | null>(null);
  const [retryName, setRetryName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const existingCapChange = sponsored && review?.allowed && review.action === "authorize";
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function submit() {
    if (working.current) return;
    if (existingCapChange && review) {
      setForm(f => ({ ...f, monthlyCap: formatUnits(review.currentCap, 18) }));
      edit();
      return;
    }
    if (!owner) return setError("Your wallet isn't ready yet.");
    if (!authorization || !isAddressEqual(authorization.vault, vault)) return setError("Couldn’t verify which vault to update. Reopen the recipient form.");
    if (agent === undefined) return setError("Still reading your vault. Try again in a moment.");
    working.current = true;
    onBusyChange?.(true);
    setBusy("Checking…");
    setError(null);
    function ensureOpen() {
      if (!mounted.current) throw new Error("The recipient form has closed.");
    }
    try {
      const reserved = { owner: getAddress(owner), vault, agent };
      const inspect = () => reviewRecipient(form, reserved, {
        directory: book.readDirectory,
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
          await authorization.authorize(recipient.address, recipient.monthlyCap);
        },
        saveName: async ({ name, address, country, currency }, expectedDetails) => {
          ensureOpen();
          setBusy("Saving contact details…");
          const guard = expectedDetails ? { expectedDetails } : { createOnly: true };
          const saved = await api("directory", { body: { name, address, country, currency, owner, ...guard } });
          if (!saved.ok) throw new Error(saved.body.error ?? `The agent answered ${saved.status}.`);
        },
      }));
      if (!mounted.current) return;
      book.changed();
      if (result.kind === "added") {
        if (mounted.current) onAdded(review.recipient.name);
      } else {
        setReview(result.review);
        setRetryName(result.kind === "retry-name");
        setError(result.kind === "retry-name"
          ? `Your vault authorization was confirmed. Saving the contact details needs another check. ${result.error}`
          : "The vault or directory changed. Review the current details before continuing.");
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      working.current = false;
      if (mounted.current) onBusyChange?.(false);
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

  const submitLabel = !review ? "Review recipient" : existingCapChange ? "Use current cap" : retryName ? (review.storedDetails ? "Retry saving details" : "Retry saving name") : {
    authorize: "Confirm in wallet", "save-name": review.storedDetails ? "Save contact details" : "Save name", done: "Done",
  }[review.action];

  return (
    <form className="add-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {review ? (
        <div className="recipient-review">
          <strong>{review.recipient.name}</strong>
          <p style={{ overflowWrap: "anywhere" }}>{review.recipient.address}</p>
          <p>{formatUnits(review.recipient.monthlyCap, 18)} USDT or USDC per 30 days{authorization?.includesPaymentFees ? ", including payment fees" : ""}</p>
          <p>Local currency: {review.recipient.currency}{review.recipient.country && ` · ${review.recipient.country}`}</p>
          {review.storedDetails && (review.storedDetails.currency !== review.recipient.currency || review.storedDetails.country !== review.recipient.country) && (
            <p className="sub">Currently saved: {review.storedDetails.currency ?? "No local currency"} · {review.storedDetails.country ?? "No country"}.</p>
          )}
          {review.action === "authorize" && <p className="sub">
            {existingCapChange
              ? `This address already has a cap of ${formatUnits(review.currentCap, 18)}. Keep it to save the contact, or open the saved contact and choose Edit cap.`
              : review.allowed ? `The current cap is ${formatUnits(review.currentCap, 18)}. Your wallet pays the network fee in tBNB when you confirm the change.`
              : sponsored ? "Sign to allow payments to this address. LeashPay covers the network fee."
              : "Confirm in your wallet to allow payments to this address. Your wallet pays the network fee in tBNB."}
          </p>}
          {review.action === "save-name" && <p className="sub">Your vault already allows this address at this cap. Only the directory needs updating.</p>}
          {review.action === "done" && <p className="sub">This name and address are already in your directory with this vault cap.</p>}
        </div>
      ) : (
        <>
          <label>Name<input autoFocus={!initial} {...field("name")} placeholder="Ramon" maxLength={60} /></label>
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
      {!review && <p className="sub">{sponsored ? "LeashPay covers the network fee to add a new recipient."
        : "Your wallet pays the network fee in tBNB when you confirm a new recipient."}</p>}
      {error && <p className="kill-error" role="alert">{error}</p>}
      <div className="add-actions">
        <button className="btn" type="submit" disabled={Boolean(busy)}>{busy ?? submitLabel}</button>
        {review && <button className="link" type="button" disabled={Boolean(busy)} onClick={edit}>Edit</button>}
        <button className="link" type="button" disabled={Boolean(busy)} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
