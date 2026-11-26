import { existsSync } from "node:fs";
import path from "node:path";
import { getAddress, zeroAddress, type Hex } from "viem";
import { z } from "zod";
import { AddressSchema } from "./validation";

const here = import.meta.dirname;

/** The repository-root .env (copied from .env.example). Never committed. */
export const ROOT_ENV_FILE = path.resolve(here, "../../.env");

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
  .transform((value) => value as Hex);

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  /** Where the server listens. The default is reachable only from this machine. */
  AGENT_HOST: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("127.0.0.1")),
  BSC_TESTNET_RPC_URL: z.url().default("https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
  FACTORY_ADDRESS: z.preprocess(emptyToUndefined, AddressSchema.optional()),
  /** Opt in only on the separate signed-action factory deployment. */
  SPONSORED_FACTORY_ADDRESS: z.preprocess(emptyToUndefined, AddressSchema.optional()),
  AGENT_PRIVATE_KEY: z.preprocess(emptyToUndefined, privateKey.optional()),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** The old name of ANTHROPIC_API_KEY (main's .env.example), still read so existing .env files keep working. */
  LLM_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  AGENT_API_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  /** Cournot's prepaid key, for when the free quota is used up. The guard works without it while free calls last. */
  COURNOT_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** CoinMarketCap Pro key, for local-currency amounts on plans. Without it, plans show dollars only. */
  CMC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Living Brain (the agent's memory). All three are needed; without them memory is off. */
  LIVING_BRAIN_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  LIVING_BRAIN_BRAIN_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  LIVING_BRAIN_SUBJECT_ID: z.preprocess(emptyToUndefined, z.uuid().optional()),
  /** "1" turns on POST /plans/:id/demo-attack for the live demo. Off unless set. */
  AGENT_DEMO_ATTACK: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
  DATA_DIR: z.string().default(path.resolve(here, "../data")),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * The only address the demo attack may target (web/lib/demo.ts uses the same one). The web
 * app refuses to allowlist it, so the vault always answers RecipientNotAllowed.
 */
export const DEMO_ATTACK_ADDRESS = getAddress("0xbad5000000000000000000000000000000000bad");

/** The agent was asked to do something its configuration can't support yet. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * The Claude API key from .env, under its current name or the old one. Undefined
 * lets the SDK fall back to an `ant auth login` profile.
 */
export function claudeApiKey(config: Pick<Config, "ANTHROPIC_API_KEY" | "LLM_API_KEY">): string | undefined {
  return config.ANTHROPIC_API_KEY ?? config.LLM_API_KEY;
}

/** True for a listen address only this machine can reach: a literal loopback address, never a hostname that looks like one. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The Host headers a request to this server can carry when it listens on this machine only. */
export function localHostHeaders(config: Pick<Config, "AGENT_HOST" | "PORT">): string[] {
  const own = config.AGENT_HOST.includes(":") ? `[${config.AGENT_HOST}]` : config.AGENT_HOST;
  return [...new Set(["localhost", "127.0.0.1", "[::1]", own])].map((host) => `${host}:${config.PORT}`);
}

/** Reads the root .env (if present) into process.env, then validates it. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration in .env:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  if (config.SPONSORED_FACTORY_ADDRESS && (config.SPONSORED_FACTORY_ADDRESS === zeroAddress || config.SPONSORED_FACTORY_ADDRESS !== config.FACTORY_ADDRESS)) {
    throw new Error("SPONSORED_FACTORY_ADDRESS must be nonzero and match FACTORY_ADDRESS on the sponsored deployment.");
  }
  if (!isLoopback(config.AGENT_HOST) && !config.AGENT_API_TOKEN) {
    throw new Error(
      `AGENT_HOST=${config.AGENT_HOST} lets other machines reach the agent, and the agent can move money. ` +
        "Set AGENT_API_TOKEN in .env as well, or leave AGENT_HOST empty to stay on this machine.",
    );
  }
  return config;
}
