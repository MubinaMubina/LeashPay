#!/usr/bin/env node
// Creates the agent's BSC testnet key and stores it as AGENT_PRIVATE_KEY in the
// repo-root .env (git-ignored). Prints only the address, never the key.
// Never replaces a key that is already set.
//
//   npm run key
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "../../.env");
const exampleFile = path.resolve(here, "../../.env.example");

if (!existsSync(envFile)) {
  copyFileSync(exampleFile, envFile);
  console.log("Created .env from .env.example.");
}

const text = readFileSync(envFile, "utf8");
const line = /^AGENT_PRIVATE_KEY=([^#\n]*)/m;
const existing = text.match(line)?.[1]?.trim();

if (existing) {
  console.log("AGENT_PRIVATE_KEY is already set in .env; leaving it unchanged.");
  console.log(`Agent address: ${privateKeyToAccount(existing).address}`);
  process.exit(0);
}

const key = generatePrivateKey();
const updated = line.test(text)
  ? text.replace(line, `AGENT_PRIVATE_KEY=${key} `)
  : `${text.trimEnd()}\nAGENT_PRIVATE_KEY=${key}\n`;
writeFileSync(envFile, updated);
chmodSync(envFile, 0o600); // the file holds a private key: owner-only

console.log(`Agent address: ${privateKeyToAccount(key).address}`);
console.log("Next: fund it with test BNB from the BSC testnet faucet, and send this address (never the key)");
console.log("to Builder A: it becomes the factory's defaultAgent.");
