#!/usr/bin/env node
// Creates the agent's BSC testnet key and stores it as AGENT_PRIVATE_KEY in the
// repo-root .env (git-ignored). Prints only the address, never the key.
// Never replaces a key that is already set.
//
//   npm run key
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = import.meta.dirname;
const envFile = path.resolve(here, "../../.env");
const exampleFile = path.resolve(here, "../../.env.example");

if (!existsSync(envFile)) {
  // Owner-only from the first byte: this file is about to hold a private key.
  writeFileSync(envFile, readFileSync(exampleFile, "utf8"), { mode: 0o600, flag: "wx" });
  console.log("Created .env from .env.example.");
}
chmodSync(envFile, 0o600); // also tightens a .env that already existed: it holds, or will hold, the key

const text = readFileSync(envFile, "utf8");
// The key's line as Node's .env loader reads it: with or without `export`, spaces around "=" or quotes.
const line = /^[ \t]*(?:export[ \t]+)?AGENT_PRIVATE_KEY[ \t]*=[ \t]*([^#\n]*)/m;
const existing = text.match(line)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");

if (existing) {
  console.log("AGENT_PRIVATE_KEY is already set in .env; leaving it unchanged.");
  console.log(`Agent address: ${privateKeyToAccount(existing).address}`);
  process.exit(0);
}

const key = generatePrivateKey();
const updated = line.test(text)
  ? text.replace(line, `AGENT_PRIVATE_KEY=${key} `)
  : `${text.trimEnd()}\nAGENT_PRIVATE_KEY=${key}\n`;
// .env holds other secrets too: write an owner-only copy, flush it, then rename it over .env,
// so a full disk or a crash leaves the old file whole, never half-written.
const tmp = `${envFile}.${process.pid}.tmp`;
try {
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, updated);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, envFile);
} catch (err) {
  rmSync(tmp, { force: true });
  throw err;
}

console.log(`Agent address: ${privateKeyToAccount(key).address}`);
console.log("Next: fund it with test BNB from the BSC testnet faucet, and send this address (never the key)");
console.log("to Builder A: it becomes the factory's defaultAgent.");
