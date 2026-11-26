import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { SponsorError } from "./authorization";

const maxDailyCost = 5n * 10n ** 16n; // 0.05 tBNB. Reserve each transaction's maximum charge.
const maxDailyAttempts = 100;
const maxOwnerDailyAttempts = 10;
const day = (seconds: bigint) => Number(seconds / 86_400n);
const Attempt = z.strictObject({
  day: z.number().int(), owner: z.string(), slot: z.string(), cap: z.string().nullable(),
  deadline: z.string().regex(/^\d+$/), cost: z.string().regex(/^\d+$/),
  raw: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).transform(value => value as Hex),
  failed: z.boolean().optional(),
});
type Attempt = z.infer<typeof Attempt>;

/** The server already holds the data directory's process lock. Only one sponsor execution runs at a time. */
export class SponsorLedger {
  private attempts: Attempt[];

  constructor(private readonly file: string) {
    this.attempts = existsSync(file) ? z.array(Attempt).parse(JSON.parse(readFileSync(file, "utf8"))) : [];
  }

  pending(slot: string, cap: string | null, now: bigint, deadline: bigint) {
    for (const entry of this.attempts) {
      if (entry.slot !== slot || BigInt(entry.deadline) < now) continue;
      if (entry.failed) {
        if (BigInt(entry.deadline) === deadline && entry.cap === cap) throw new SponsorError(409, "This transaction reverted. Approve a fresh request.");
        continue;
      }
      if (entry.cap !== cap) throw new SponsorError(409, "Another approval for this recipient is awaiting confirmation.");
      return entry;
    }
  }

  checkBudget(owner: Address, now: bigint, cost: bigint) {
    const today = this.attempts.filter(entry => entry.day === day(now));
    const reserved = today.reduce((sum, entry) => sum + BigInt(entry.cost), 0n);
    if (today.length >= maxDailyAttempts || reserved + cost > maxDailyCost) {
      throw new SponsorError(429, "The testnet sponsor has reached its daily limit. Try again after 00:00 UTC.");
    }
    if (today.filter(entry => entry.owner === owner).length >= maxOwnerDailyAttempts) {
      throw new SponsorError(429, "Your account reached its daily sponsored transaction limit. Try again after 00:00 UTC.");
    }
  }

  record(owner: Address, now: bigint, slot: string, cap: string | null, deadline: bigint, cost: bigint, raw: Hex) {
    const recent = this.attempts.filter(entry => entry.day >= day(now) || BigInt(entry.deadline) >= now);
    const entry = { owner, day: day(now), slot, cap, deadline: String(deadline), cost: String(cost), raw };
    this.write([...recent, entry]);
    return entry;
  }

  failed(entry: Attempt) {
    this.write(this.attempts.map(saved => saved === entry ? { ...saved, failed: true } : saved));
  }

  private write(entries: Attempt[]) {
    const tmp = this.file + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600, flush: true });
    renameSync(tmp, this.file);
    this.attempts = entries;
  }
}
