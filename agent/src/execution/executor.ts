import { BaseError, InsufficientFundsError, type Address, type Hex } from "viem";
import { VaultRevertError, type VaultRevert } from "../chain/errors";
import type { DeploymentConfig, PayStep, PaymentCheck, SignedPayment, VaultGateway } from "../chain/gateway";
import { ConfigurationError } from "../config";
import type { TokenSymbol } from "../plan/directory";
import { isExecutable, type ExecutablePayment, type Plan } from "../plan/build";
import type { Journal, JournalEvent } from "./journal";

/** The note on a row an earlier run already paid: nothing new happened in this run. */
export const ALREADY_PAID_NOTE = "Already paid in an earlier run.";
/** The note on a row sent in an earlier run that this run only confirmed. */
export const CONFIRMED_EARLIER_NOTE = "Confirmed from an earlier run.";

export interface PaymentResult {
  index: number;
  recipientName: string;
  recipient: Address | null;
  /** 18-decimal base units, like plan responses ("300000000000000000000" is 300). */
  amount: string | null;
  token: TokenSymbol;
  /** pending: sent, but not final yet (or the chain couldn't be asked); running the plan again settles it. */
  status: "paid" | "pending" | "refused" | "failed" | "skipped";
  hash?: Hex | null;
  error?: VaultRevert | string;
  note?: string;
}

/** The agent's one key sends one plan at a time, so its transactions take nonces in order. */
export class AgentBusyError extends Error {
  constructor(vault: Address) {
    super(`The agent is already running a plan (vault ${vault}). Try again when it finishes.`);
    this.name = "AgentBusyError";
  }
}

/** The demo attack was asked to send something it never sends; nothing went out. */
export class AttackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttackRefusedError";
  }
}

/** What the demo attack's one transaction did, once its block is final (or still pending). */
export interface AttackResult {
  index: number;
  recipient: Address;
  hash: Hex;
  status: "reverted" | "succeeded" | "pending";
  /** The vault error's name, such as RecipientNotAllowed, when one was found. */
  reason: string | null;
  reasonMessage?: string;
  /** replay: the same call re-run at the block before; preview: the vault check made with the plan. */
  reasonSource: "replay" | "preview" | null;
  block: string | null;
}

/** Enough for any refusal path in pay(); a fixed limit, because the attack skips gas estimation. */
export const DEMO_ATTACK_GAS = 200_000n;

export interface ExecutorDeps {
  gateway: VaultGateway;
  journal: Journal;
}

type Base = Omit<PaymentResult, "status">;
type StepEvent = Extract<JournalEvent, { index: number }>;

/** A failure message that is safe to show and to journal: viem's short message never includes the RPC URL. */
function describeFailure(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return "The agent wallet has no test BNB to pay for gas. Fund it from the BSC testnet faucet.";
    }
    return err.shortMessage;
  }
  return "The agent couldn't send this payment.";
}

const NOT_FINAL_YET = "Sent and not final yet. Run the plan again in a moment to confirm it.";

/**
 * Runs a confirmed plan: one pay() per recipient, one plan at a time. Each payment is
 * signed first, its hash journaled, and only then broadcast, so a crash at any moment
 * leaves a hash the next run can look up on the chain. A payment counts as paid only
 * when the chain's finalized state shows it: the vault's Paid event in a finalized
 * block, or the vault refusing it as a duplicate as of the finalized block. The vault's
 * DuplicatePayment rule (each plan pays each person once) is the last line of defense.
 * A refused or stuck payment doesn't stop the others.
 */
export class Executor {
  private running: Address | null = null;

  constructor(private readonly deps: ExecutorDeps) {}

  async execute(plan: Plan): Promise<PaymentResult[]> {
    if (!plan.vault) throw new Error("This plan has no vault, so there is nothing to execute.");
    if (!this.deps.gateway.agentAddress) {
      throw new ConfigurationError("AGENT_PRIVATE_KEY is not set in .env, so the agent can't send payments.");
    }
    if (this.running) throw new AgentBusyError(this.running);
    this.running = plan.vault;
    try {
      const tokens = await this.deps.gateway.deployment();
      const results: PaymentResult[] = [];
      for (const [index, payment] of plan.payments.entries()) {
        const base: Base = {
          index,
          recipientName: payment.recipientName,
          recipient: payment.recipient,
          amount: payment.amount === null ? null : payment.amount.toString(),
          token: payment.token,
        };
        results.push(
          isExecutable(payment)
            ? await this.runPayment(plan, plan.vault, index, payment, tokens, base)
            : { ...base, status: "skipped", note: payment.warnings.join(" ") || "Nothing to pay." },
        );
      }
      if (!results.some((r) => r.status === "pending")) {
        this.deps.journal.append({ type: "plan_finished", planId: plan.id });
      }
      return results;
    } finally {
      this.running = null;
    }
  }

  /**
   * The demo attack: plays a compromised agent that pays without the owner's signature, and
   * shows the vault refusing it on-chain. It can never move money: it only ever targets
   * `target` (an address the web app refuses to allowlist), re-checks right before signing
   * that the vault doesn't allow it, and refuses any plan with another payable row. It takes
   * the same single-plan lock, nonce handling and journal as real payments.
   */
  async demoAttack(plan: Plan, target: Address): Promise<AttackResult[]> {
    if (!plan.vault) throw new Error("This plan has no vault, so there is nothing to execute.");
    if (!this.deps.gateway.agentAddress) {
      throw new ConfigurationError("AGENT_PRIVATE_KEY is not set in .env, so the agent can't send payments.");
    }
    if (this.running) throw new AgentBusyError(this.running);
    this.running = plan.vault;
    try {
      const payable = [...plan.payments.entries()].filter((entry): entry is [number, ExecutablePayment] => isExecutable(entry[1]));
      const only = payable.length === 1 ? payable[0] : undefined;
      if (!only || only[1].recipient.toLowerCase() !== target.toLowerCase()) {
        throw new AttackRefusedError(`The demo attack only sends one payment, to ${target}. Nothing was sent.`);
      }
      const [index, payment] = only;
      const tokens = await this.deps.gateway.deployment();
      const step: PayStep = {
        recipient: target,
        token: payment.token === "USDC" ? tokens.usdc : tokens.usdt,
        amount: payment.amount,
        ref: plan.ref,
      };
      if (await this.deps.gateway.isAllowed(plan.vault, target)) {
        throw new AttackRefusedError("This vault allows the demo attack address, so the attack could pay it. Nothing was sent.");
      }

      const signed = await this.deps.gateway.signPayUnchecked(plan.vault, step, DEMO_ATTACK_GAS);
      try {
        this.deps.journal.append({ type: "demo_attack_sent", planId: plan.id, index, hash: signed.hash });
      } catch (err) {
        signed.discard();
        throw err;
      }
      await signed.broadcast();
      const outcome = await this.deps.gateway.waitForOutcome(signed.hash);

      let reason: VaultRevert | null = null;
      let reasonSource: AttackResult["reasonSource"] = null;
      if (outcome.status === "reverted" && outcome.block !== null) {
        try {
          reason = await this.deps.gateway.replayRevert(plan.vault, step, outcome.block);
          if (reason) reasonSource = "replay";
        } catch {
          // the node couldn't replay it: fall back to the check made with the plan
        }
        if (!reason && payment.preview) {
          reason = payment.preview;
          reasonSource = "preview";
        }
        this.deps.journal.append({
          type: "step_failed",
          planId: plan.id,
          index,
          hash: signed.hash,
          error: reason ? `${reason.name}: ${reason.message}` : "The transaction reverted on-chain.",
        });
      } else if (outcome.status === "succeeded") {
        this.deps.journal.append({
          type: "step_succeeded",
          planId: plan.id,
          index,
          hash: signed.hash,
          note: "Demo attack: the vault did NOT refuse this payment.",
        });
      }
      return [
        {
          index,
          recipient: target,
          hash: signed.hash,
          status: outcome.status,
          reason: reason?.name ?? null,
          ...(reason ? { reasonMessage: reason.message } : {}),
          reasonSource,
          block: outcome.block === null ? null : outcome.block.toString(),
        },
      ];
    } finally {
      this.running = null;
    }
  }

  private async runPayment(
    plan: Plan,
    vault: Address,
    index: number,
    payment: ExecutablePayment,
    tokens: DeploymentConfig,
    base: Base,
  ): Promise<PaymentResult> {
    const { gateway, journal } = this.deps;
    const step: PayStep = {
      recipient: payment.recipient,
      token: payment.token === "USDC" ? tokens.usdc : tokens.usdt,
      amount: payment.amount,
      ref: plan.ref,
    };

    // 1. What happened to this payment in earlier runs?
    const history = journal
      .eventsFor(plan.id)
      .filter((e): e is StepEvent => "index" in e && e.index === index);
    const succeeded = history.find((e) => e.type === "step_succeeded");
    if (succeeded) {
      // Success is journaled only once the chain's finalized state shows it.
      return { ...base, status: "paid", hash: succeeded.hash, note: ALREADY_PAID_NOTE };
    }

    // 2. Every transaction sent earlier, newest first: while any of them could still land, never send another.
    const sent = history.flatMap((e) => (e.type === "step_sent" ? [e.hash] : [])).reverse();
    for (const hash of sent) {
      let check: PaymentCheck;
      try {
        check = await gateway.checkPayment(vault, step, hash);
        if (check.status === "pending") check = await gateway.waitForPayment(vault, step, hash);
      } catch (err) {
        console.error(`plan ${plan.id}, payment ${index}: couldn't check ${hash}`, err);
        return {
          ...base,
          status: "pending",
          hash,
          error: describeFailure(err),
          note: "Couldn't check an earlier transaction with the BSC node. Run the plan again.",
        };
      }
      if (check.status === "paid" || check.status === "pending") {
        return this.record(plan.id, index, base, check, hash, history, CONFIRMED_EARLIER_NOTE);
      }
      if (check.status === "not_paid") this.record(plan.id, index, base, check, hash, history);
      // Reverted, replaced or never arrived: look at the next one, then send again below.
    }

    // 3. Simulate and sign. A refusal here means nothing was signed or sent.
    let signed: SignedPayment;
    try {
      signed = await gateway.signPay(vault, step);
    } catch (err) {
      if (err instanceof VaultRevertError) {
        if (err.revert.name === "DuplicatePayment") return this.confirmDuplicate(plan.id, index, vault, step, base, err.revert);
        journal.append({ type: "step_refused", planId: plan.id, index, error: err.revert });
        return { ...base, status: "refused", error: err.revert };
      }
      console.error(`plan ${plan.id}, payment ${index}: couldn't sign`, err);
      const error = describeFailure(err);
      journal.append({ type: "step_failed", planId: plan.id, index, hash: null, error });
      return { ...base, status: "failed", error };
    }

    // 4. Journal the hash before broadcasting, so any crash from here on can be reconciled from the chain.
    try {
      journal.append({ type: "step_sent", planId: plan.id, index, hash: signed.hash });
    } catch (err) {
      signed.discard(); // it will never be sent: give its nonce back, or every later payment waits behind it
      throw err;
    }
    let outcome: PaymentCheck;
    try {
      await signed.broadcast();
      outcome = await gateway.waitForPayment(vault, step, signed.hash);
    } catch (err) {
      console.error(`plan ${plan.id}, payment ${index}: sent ${signed.hash}, outcome unknown`, err);
      return {
        ...base,
        status: "pending",
        hash: signed.hash,
        error: describeFailure(err),
        note: "Sent, but the BSC node didn't confirm it. Run the plan again to check.",
      };
    }
    const result = this.record(plan.id, index, base, outcome, signed.hash, history);
    if (outcome.status !== "not_paid") return result;
    // A revert can mean an earlier transaction already paid this person, so the vault refused
    // the repeat. Report "failed" only when the vault doesn't count the payment as made.
    const duplicate = await this.duplicateRefusal(vault, step);
    return duplicate ? this.confirmDuplicate(plan.id, index, vault, step, base, duplicate) : result;
  }

  /** The vault's own answer, as of the latest block, to "would paying this again be a duplicate?" */
  private async duplicateRefusal(vault: Address, step: PayStep): Promise<VaultRevert | null> {
    const { gateway } = this.deps;
    if (!gateway.agentAddress) return null;
    try {
      const revert = await gateway.previewPay(vault, step, gateway.agentAddress);
      return revert?.name === "DuplicatePayment" ? revert : null;
    } catch {
      return null; // can't ask the node right now: keep the receipt's answer
    }
  }

  /**
   * The vault refused the payment as a duplicate: this plan already paid this person.
   * The refusal came from the latest block, which a reorganization could still undo,
   * so it counts only once the finalized block says the same.
   */
  private async confirmDuplicate(
    planId: string,
    index: number,
    vault: Address,
    step: PayStep,
    base: Base,
    revert: VaultRevert,
  ): Promise<PaymentResult> {
    let final = false;
    try {
      final = await this.deps.gateway.paidAsOfFinality(vault, step);
    } catch (err) {
      console.error(`plan ${planId}, payment ${index}: couldn't confirm the duplicate`, err);
    }
    if (!final) {
      return { ...base, status: "pending", hash: null, note: "The vault already counts this payment, but it isn't final yet. Run the plan again in a moment." };
    }
    this.deps.journal.append({ type: "step_succeeded", planId, index, hash: null, note: revert.message });
    return { ...base, status: "paid", hash: null, note: revert.message };
  }

  /** Turns the chain's answer into a result, journaling it once (only final answers are journaled). */
  private record(
    planId: string,
    index: number,
    base: Base,
    check: PaymentCheck,
    sent: Hex,
    history: StepEvent[],
    note?: string,
  ): PaymentResult {
    const { journal } = this.deps;
    switch (check.status) {
      case "paid":
        journal.append({ type: "step_succeeded", planId, index, hash: check.hash, ...(note ? { note } : {}) });
        return { ...base, status: "paid", hash: check.hash, ...(note ? { note } : {}) };
      case "not_paid":
        if (!history.some((e) => e.type === "step_failed" && e.hash === check.hash)) {
          journal.append({
            type: "step_failed",
            planId,
            index,
            hash: check.hash,
            error: check.reason,
            ...(check.replacedBy ? { replacedBy: check.replacedBy } : {}),
          });
        }
        return { ...base, status: "failed", hash: check.hash, error: check.reason };
      case "pending":
      case "unknown":
        return { ...base, status: "pending", hash: sent, note: NOT_FINAL_YET };
    }
  }
}
