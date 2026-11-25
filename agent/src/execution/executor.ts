import { formatUnits, type Address, type Hex } from "viem";
import { VaultRevertError, type VaultRevert } from "../chain/errors";
import type { VaultGateway } from "../chain/gateway";
import type { TokenSymbol } from "../plan/directory";
import { isExecutable, type Plan, type PlannedPayment } from "../plan/build";
import type { Journal, JournalEvent } from "./journal";

export interface PaymentResult {
  index: number;
  recipientName: string;
  recipient: Address | null;
  amount: string | null;
  token: TokenSymbol;
  status: "paid" | "refused" | "failed" | "skipped";
  hash?: Hex | null;
  error?: VaultRevert | string;
  note?: string;
}

export class VaultBusyError extends Error {
  constructor(vault: Address) {
    super(`Another plan is already running on vault ${vault}. Try again when it finishes.`);
    this.name = "VaultBusyError";
  }
}

export interface ExecutorDeps {
  gateway: VaultGateway;
  journal: Journal;
  /** Resolves USDT/USDC to the deployment's token address. */
  tokenAddress: (symbol: TokenSymbol) => Promise<Address>;
}

/**
 * Runs a confirmed plan: one pay() per recipient, one plan per vault at a time.
 * Every step is journaled before and after it touches the chain, and a retry
 * first asks the chain what happened, so a payment is never sent twice.
 * A refused payment doesn't stop the others.
 */
export class Executor {
  private readonly running = new Set<Address>();

  constructor(private readonly deps: ExecutorDeps) {}

  async execute(plan: Plan): Promise<PaymentResult[]> {
    if (!plan.vault) throw new Error("This plan has no vault, so there is nothing to execute.");
    if (this.running.has(plan.vault)) throw new VaultBusyError(plan.vault);
    this.running.add(plan.vault);
    try {
      const results: PaymentResult[] = [];
      for (const [index, payment] of plan.payments.entries()) {
        results.push(await this.runPayment(plan, plan.vault, index, payment));
      }
      this.deps.journal.append({ type: "plan_finished", planId: plan.id });
      return results;
    } finally {
      this.running.delete(plan.vault);
    }
  }

  private async runPayment(plan: Plan, vault: Address, index: number, payment: PlannedPayment): Promise<PaymentResult> {
    const { gateway, journal } = this.deps;
    const base = {
      index,
      recipientName: payment.recipientName,
      recipient: payment.recipient,
      amount: payment.amount === null ? null : formatUnits(payment.amount, 18),
      token: payment.token,
    };
    if (!isExecutable(payment)) {
      return { ...base, status: "skipped", note: payment.warnings.join(" ") || "Nothing to pay." };
    }

    // 1. What already happened to this step in earlier runs?
    const history = journal
      .eventsFor(plan.id)
      .filter((e): e is Extract<JournalEvent, { index: number }> => "index" in e && e.index === index);
    const succeeded = history.find((e) => e.type === "step_succeeded");
    if (succeeded) {
      return { ...base, status: "paid", hash: succeeded.hash, note: "Already paid in an earlier run." };
    }
    const lastSent = history.filter((e) => e.type === "step_sent").at(-1);
    if (lastSent) {
      const status = await gateway.receiptStatus(lastSent.hash);
      const settled = status === "pending" ? await gateway.waitForReceipt(lastSent.hash) : status;
      if (settled === "success") {
        journal.append({ type: "step_succeeded", planId: plan.id, index, hash: lastSent.hash, note: "Confirmed after a retry." });
        return { ...base, status: "paid", hash: lastSent.hash, note: "Confirmed from an earlier run." };
      }
      // Reverted or dropped: fall through and try again. The vault's own checks still apply.
    }

    // 2. Simulate and send. A refusal in simulation means nothing was sent.
    const step = { recipient: payment.recipient, token: await this.deps.tokenAddress(payment.token), amount: payment.amount, ref: plan.ref };
    let hash: Hex;
    try {
      hash = await gateway.sendPay(vault, step);
    } catch (err) {
      if (err instanceof VaultRevertError) {
        if (err.revert.name === "DuplicatePayment") {
          // The chain proves this exact payment already went through.
          journal.append({ type: "step_succeeded", planId: plan.id, index, hash: null, note: err.revert.message });
          return { ...base, status: "paid", hash: null, note: err.revert.message };
        }
        journal.append({ type: "step_refused", planId: plan.id, index, error: err.revert });
        return { ...base, status: "refused", error: err.revert };
      }
      const message = err instanceof Error ? err.message : String(err);
      journal.append({ type: "step_failed", planId: plan.id, index, hash: null, error: message });
      return { ...base, status: "failed", error: message };
    }

    // 3. Journal the hash before waiting, so a crash here can be reconciled later.
    journal.append({ type: "step_sent", planId: plan.id, index, hash });
    const outcome = await gateway.waitForReceipt(hash);
    if (outcome === "success") {
      journal.append({ type: "step_succeeded", planId: plan.id, index, hash });
      return { ...base, status: "paid", hash };
    }
    journal.append({ type: "step_failed", planId: plan.id, index, hash, error: "The transaction reverted on-chain." });
    return { ...base, status: "failed", hash, error: "The transaction reverted on-chain." };
  }
}
