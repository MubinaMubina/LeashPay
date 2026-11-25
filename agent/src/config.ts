import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository-root .env (copied from .env.example). Never committed. */
export const ROOT_ENV_FILE = path.resolve(here, "../../.env");

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "must be a 0x address")
  .transform((value) => getAddress(value) as Address);

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
  .transform((value) => value as Hex);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  BSC_TESTNET_RPC_URL: z.url().default("https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
  FACTORY_ADDRESS: z.preprocess(emptyToUndefined, address.optional()),
  AGENT_PRIVATE_KEY: z.preprocess(emptyToUndefined, privateKey.optional()),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  AGENT_API_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  DATA_DIR: z.string().default(path.resolve(here, "../data")),
});

export type Config = z.infer<typeof EnvSchema>;

/** The agent was asked to do something its configuration can't support yet. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Reads the root .env (if present) into process.env, then validates it. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration in .env:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
