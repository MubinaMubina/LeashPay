import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

export type TokenSymbol = "USDT" | "USDC";

export const RecipientEntrySchema = z.object({
  name: z.string().trim().min(1),
  address: z
    .string()
    .refine((value) => isAddress(value, { strict: false }), "must be a 0x address")
    .transform((value) => getAddress(value) as Address),
  country: z.string().trim().optional(),
  currency: z.string().trim().toUpperCase().optional(),
  preferredToken: z.enum(["USDT", "USDC"]).optional(),
});

export type RecipientEntry = z.infer<typeof RecipientEntrySchema>;

/**
 * The owner's address book: who "Linh" or "Marco" is. Human details live here
 * (off-chain, like the agent's memory); the vault's on-chain allowlist still
 * decides who can actually be paid.
 */
export class RecipientDirectory {
  constructor(private readonly file: string) {}

  list(): RecipientEntry[] {
    if (!existsSync(this.file)) return [];
    return z.array(RecipientEntrySchema).parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  /** Adds a recipient, or updates the one with the same address. */
  upsert(entry: RecipientEntry): RecipientEntry[] {
    const others = this.list().filter((e) => e.address !== entry.address);
    const next = [...others, entry].sort((a, b) => a.name.localeCompare(b.name));
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
