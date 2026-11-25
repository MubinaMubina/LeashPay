import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import { z } from "zod";
import { AddressSchema, TextSchema } from "../validation";

export type TokenSymbol = "USDT" | "USDC";

/** Most recipients one owner can keep; each one is sent to Claude with every plan. */
export const MAX_RECIPIENTS = 200;

export const RecipientEntrySchema = z.object({
  name: TextSchema(60),
  address: AddressSchema,
  country: TextSchema(60).optional(),
  currency: TextSchema(10).toUpperCase().optional(),
  preferredToken: z.enum(["USDT", "USDC"]).optional(),
});

export type RecipientEntry = z.infer<typeof RecipientEntrySchema>;

const DirectoryFileSchema = z.record(z.string(), z.array(RecipientEntrySchema));

/** A file the agent keeps in its data folder is unreadable: a server problem, not the caller's. */
export class DataFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataFileError";
  }
}

/** The change breaks a directory rule: a name used twice, or too many recipients. */
export class DirectoryRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryRuleError";
  }
}

/**
 * Each owner's address book: who "Linh" or "Marco" is. Human details live here
 * (off-chain, like the agent's memory); the vault's on-chain allowlist still
 * decides who can actually be paid. Stored as { ownerAddress: entries } in one file.
 */
export class RecipientDirectory {
  constructor(private readonly file: string) {}

  list(owner: Address): RecipientEntry[] {
    return this.read()[owner] ?? [];
  }

  /** Adds a recipient, or updates the one with the same address. */
  upsert(owner: Address, entry: RecipientEntry): RecipientEntry[] {
    const all = this.read();
    const others = (all[owner] ?? []).filter((e) => e.address !== entry.address);
    // Names must be unique per owner, so "pay Linh" can never mean two people.
    const sameName = others.find((e) => e.name.toLowerCase() === entry.name.toLowerCase());
    if (sameName) {
      throw new DirectoryRuleError(
        `You already have a recipient named ${sameName.name} (${sameName.address}). Use a different name.`,
      );
    }
    if (others.length >= MAX_RECIPIENTS) {
      throw new DirectoryRuleError(`An owner can keep at most ${MAX_RECIPIENTS} recipients.`);
    }
    const next = [...others, entry].sort((a, b) => a.name.localeCompare(b.name));
    this.write({ ...all, [owner]: next });
    return next;
  }

  private read(): Record<string, RecipientEntry[]> {
    if (!existsSync(this.file)) return {};
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      console.error(`directory: ${this.file} is not valid JSON`, err);
      throw new DataFileError(
        "The recipient directory file (recipients.json in the agent's data folder) is damaged. Fix or delete it.",
      );
    }
    const parsed = DirectoryFileSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(`directory: ${this.file} doesn't match the expected format`, parsed.error);
      throw new DataFileError(
        "The recipient directory file (recipients.json in the agent's data folder) has an entry the agent can't read. Fix or delete it.",
      );
    }
    return parsed.data;
  }

  /**
   * Writes every byte to a temporary file, flushes it, then renames it over the old one:
   * a crash or a full disk leaves the old file or the new one, never half of one.
   */
  private write(data: Record<string, RecipientEntry[]>): void {
    // Recipients' names, countries and addresses: readable only by the account running the agent.
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); // retries short writes, unlike writeSync
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}
