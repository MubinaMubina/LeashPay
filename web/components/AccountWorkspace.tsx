"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { errorText, useSendAndWait } from "@/lib/client";
import { activatePaymentVault, readOwnerVault } from "@/lib/onboarding";
import { Dashboard } from "./Dashboard";
import type { AccessPrompt } from "./AccessNotice";

export function AccountWorkspace({ owner, guest, login }: { owner: Address | null; guest: boolean; login: () => void }) {
  const [vault, setVault] = useState<Address | null>(null);
  const [phase, setPhase] = useState<"checking" | "inactive" | "activating" | "unavailable">("checking");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  const sendAndWait = useSendAndWait();

  useEffect(() => {
    if (!owner) return;
    let current = true;
    void readOwnerVault(owner).then(found => {
      if (!current) return;
      if (found) setVault(found);
      else setPhase("inactive");
    }).catch(() => { if (current) setPhase("unavailable"); });
    return () => { current = false; };
  }, [owner, attempt]);

  function retry() {
    setPhase("checking");
    setAttempt(n => n + 1);
  }

  async function activate() {
    if (!owner || phase !== "inactive" || busy.current) return;
    busy.current = true;
    setPhase("activating");
    setError("");
    try {
      setVault(await activatePaymentVault(owner, sendAndWait));
    } catch (err) {
      setError(errorText(err));
      retry();
    } finally {
      busy.current = false;
    }
  }

  function getPrompt(): AccessPrompt | null {
    if (guest) return { state: "guest", title: "Log in to use your account",
      detail: "Log in with your email to use the payment agent and manage recipients.", action: { label: "Log in with email", run: login } };
    if (vault) return null;
    switch (phase) {
      case "inactive": return { state: phase, title: "Activate your vault first",
        detail: "Your vault keeps track of who you can pay and how much. Activation needs a little tBNB for the testnet fee.",
        action: { label: "Activate vault", run: activate }, error };
      case "unavailable": return { state: phase, title: "Vault status unavailable",
        detail: "We couldn’t check your vault. Try the lookup again.", action: { label: "Check again", run: retry } };
      case "activating": return { state: phase, title: "Activating your vault…", detail: "You can keep browsing while the transaction confirms." };
      case "checking": return { state: phase, title: "Checking account access…", detail: "Please try your request again in a moment." };
    }
  }

  return <Dashboard owner={owner} vault={vault} access={getPrompt()} />;
}
