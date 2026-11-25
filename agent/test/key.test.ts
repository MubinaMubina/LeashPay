import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./fakes";

const agentDir = path.resolve(import.meta.dirname, "..");

/** A throwaway copy of the repository layout the script expects: <root>/.env and <root>/agent/scripts. */
function sandbox() {
  const root = tempDir();
  mkdirSync(path.join(root, "agent/scripts"), { recursive: true });
  copyFileSync(path.join(agentDir, "scripts/new-agent-key.mjs"), path.join(root, "agent/scripts/new-agent-key.mjs"));
  symlinkSync(path.join(agentDir, "node_modules"), path.join(root, "agent/node_modules"));
  const run = () => execFileSync("node", [path.join(root, "agent/scripts/new-agent-key.mjs")], { encoding: "utf8" });
  return { root, env: path.join(root, ".env"), run };
}

const mode = (file: string) => statSync(file).mode & 0o777;

describe("npm run key", () => {
  it("creates .env owner-only, writes a key and prints only the address", () => {
    const { root, env, run } = sandbox();
    writeFileSync(path.join(root, ".env.example"), "AGENT_PRIVATE_KEY=          # agent role only\n");
    chmodSync(path.join(root, ".env.example"), 0o644);

    const output = run();

    expect(mode(env)).toBe(0o600);
    const key = readFileSync(env, "utf8").match(/^AGENT_PRIVATE_KEY=(0x[0-9a-f]{64})/m)?.[1];
    expect(key).toBeDefined();
    expect(output).toMatch(/Agent address: 0x[0-9a-fA-F]{40}/);
    expect(output).not.toContain(key!.slice(2));
  });

  it("recognizes the key however Node's .env loader would read it, and leaves it alone", () => {
    const key = `0x${"11".repeat(32)}`;
    for (const existing of [`export AGENT_PRIVATE_KEY=${key}\n`, `AGENT_PRIVATE_KEY = ${key}\n`, `AGENT_PRIVATE_KEY="${key}"\n`]) {
      const { env, run } = sandbox();
      writeFileSync(env, existing);
      run();
      expect(readFileSync(env, "utf8")).toBe(existing);
    }
  });

  it("makes an existing key file owner-only and never replaces its key", () => {
    const { env, run } = sandbox();
    const key = `0x${"11".repeat(32)}`;
    writeFileSync(env, `AGENT_PRIVATE_KEY=${key}\n`);
    chmodSync(env, 0o644);

    run();

    expect(mode(env)).toBe(0o600);
    expect(readFileSync(env, "utf8")).toBe(`AGENT_PRIVATE_KEY=${key}\n`);
  });
});
