import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { VaultRevert } from "../chain/errors";
import { bigintReplacer, planFromJson, type PlanJson } from "../json";
import type { Plan } from "../plan/build";

export type JournalEvent =
  | { type: "plan_created"; planId: string; at: string; plan: PlanJson }
  /** A pay() transaction was broadcast; its outcome is not known yet. */
  | { type: "step_sent"; planId: string; at: string; index: number; hash: Hex }
  /** The payment is confirmed on-chain (hash is null when proven by DuplicatePayment). */
  | { type: "step_succeeded"; planId: string; at: string; index: number; hash: Hex | null; note?: string }
  /** The transaction failed on-chain, or sending failed for a non-vault reason. */
  | { type: "step_failed"; planId: string; at: string; index: number; hash: Hex | null; error: string }
  /** The vault refused the payment in simulation, so nothing was sent. */
  | { type: "step_refused"; planId: string; at: string; index: number; error: VaultRevert }
  | { type: "plan_finished"; planId: string; at: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewJournalEvent = DistributiveOmit<JournalEvent, "at">;

/**
 * Append-only record of every plan and every on-chain step, one JSON object per
 * line. It is what makes retries safe: before sending anything, the executor
 * reads what already happened here and checks it against the chain.
 */
export class Journal {
  private readonly events: JournalEvent[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.events.push(JSON.parse(line) as JournalEvent);
      }
    }
  }

  append(event: NewJournalEvent): JournalEvent {
    const full = { ...event, at: this.now().toISOString() } as JournalEvent;
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(full, bigintReplacer)}\n`);
    this.events.push(full);
    return full;
  }

  eventsFor(planId: string): JournalEvent[] {
    return this.events.filter((e) => e.planId === planId);
  }

  plan(planId: string): Plan | null {
    const created = this.events.find(
      (e): e is Extract<JournalEvent, { type: "plan_created" }> => e.type === "plan_created" && e.planId === planId,
    );
    return created ? planFromJson(created.plan) : null;
  }
}
