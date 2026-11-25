import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { VaultRevert } from "../chain/errors";
import { bigintReplacer, planFromJson, type PlanJson } from "../json";
import type { Plan } from "../plan/build";

export type JournalEvent =
  | { type: "plan_created"; planId: string; at: string; plan: PlanJson }
  /** A signed pay() transaction, journaled before it is broadcast. Its outcome is not known yet. */
  | { type: "step_sent"; planId: string; at: string; index: number; hash: Hex }
  /** The payment is final on-chain (hash is null when proven by the vault's DuplicatePayment refusal). */
  | { type: "step_succeeded"; planId: string; at: string; index: number; hash: Hex | null; note?: string }
  /**
   * The transaction failed on-chain, or the payment couldn't be signed. `hash` is the
   * agent's own transaction; `replacedBy` the one that took its nonce, if any.
   */
  | { type: "step_failed"; planId: string; at: string; index: number; hash: Hex | null; error: string; replacedBy?: Hex }
  /** The vault refused the payment in simulation, so nothing was sent. */
  | { type: "step_refused"; planId: string; at: string; index: number; error: VaultRevert }
  /** A run ended with every payment settled (none still pending). */
  | { type: "plan_finished"; planId: string; at: string }
  /** The owner's signed approval was used; each one runs its plan once. `approval` hashes the signed text. */
  | { type: "approval_used"; planId: string; at: string; approval: Hex };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewJournalEvent = DistributiveOmit<JournalEvent, "at">;

/**
 * Append-only record of every plan and every on-chain step, one JSON object per
 * line. It is what makes retries safe: before sending anything, the executor
 * reads what already happened here and checks it against the chain.
 */
export class Journal {
  private readonly events: JournalEvent[] = [];
  /** Set when half a record may be left at the end of the file: no more appends until a restart repairs it. */
  private broken: Error | null = null;

  constructor(private readonly file: string) {
    if (existsSync(file)) this.load();
  }

  append(event: NewJournalEvent): JournalEvent {
    if (this.broken) {
      throw new Error(`The journal can't take more records until the agent restarts (${this.broken.message}).`);
    }
    const full = { ...event, at: new Date().toISOString() } as JournalEvent;
    // Owners' messages and recipients live here: readable only by the account running the agent.
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const size = existsSync(this.file) ? statSync(this.file).size : 0;
    try {
      // Writes every byte (retrying short writes) and flushes it to disk before returning,
      // so a crash of the agent after this line can't lose the record.
      appendFileSync(this.file, `${JSON.stringify(full, bigintReplacer)}\n`, { flush: true, mode: 0o600 });
    } catch (err) {
      // A full disk can leave part of the record behind: cut it off, so the next append
      // doesn't follow half a line and make the journal unreadable.
      try {
        truncateSync(this.file, size);
      } catch {
        // The fragment may still be there. Writing more would bury it mid-file, where a
        // restart can't repair it, so refuse every append (and so every payment) instead.
        this.broken = err as Error;
      }
      throw err;
    }
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

  private load(): void {
    const lines = readFileSync(this.file, "utf8").split("\n");
    let offset = 0; // byte offset where the current line starts
    for (const [i, line] of lines.entries()) {
      const last = i === lines.length - 1; // the text after the final newline, if any
      if (line.trim()) {
        try {
          this.events.push(JSON.parse(line) as JournalEvent);
        } catch {
          if (!last) {
            throw new Error(
              `The journal ${this.file} is damaged at line ${i + 1}, so the agent can't tell which payments went out. ` +
                "Nothing was changed: fix or move that file, then start again.",
            );
          }
          // A crash in the middle of an append leaves a partial last line with no
          // newline after it. Every record before it is complete: cut the fragment off.
          truncateSync(this.file, offset);
          console.warn(`journal: removed an incomplete last record left by a crash (${Buffer.byteLength(line)} bytes)`);
          return;
        }
        // A complete record that lost its newline: finish the line so the next append starts on its own.
        if (last) appendFileSync(this.file, "\n");
      }
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
  }
}
