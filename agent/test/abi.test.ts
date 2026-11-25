import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { faucetTokenAbi, leashVaultAbi, leashVaultFactoryAbi, priceFeedAbi } from "../src/abi/generated";
import { tempDir } from "./fakes";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

describe("generated ABI", () => {
  it("produces exactly the frozen signature list (same entries, types and indexed flags)", () => {
    const dir = tempDir();
    const sections = { ILeashVault: leashVaultAbi, ILeashVaultFactory: leashVaultFactoryAbi, IPriceFeed: priceFeedAbi, IFaucetToken: faucetTokenAbi };
    const pairs = Object.entries(sections).map(([section, abi]) => {
      const file = path.join(dir, `${section}.json`);
      writeFileSync(file, JSON.stringify(abi));
      return `${section}=${file}`;
    });

    const generated = execFileSync("node", [path.join(repoRoot, "scripts/abi-signatures.mjs"), ...pairs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    expect(generated).toBe(readFileSync(path.join(repoRoot, "contracts/abi/frozen-signatures.txt"), "utf8"));
  });

  it("is up to date with the Solidity interfaces", () => {
    // Exits non-zero (and throws here) if src/abi/generated.ts is stale.
    expect(() => execFileSync("node", [path.join(here, "../scripts/gen-abi.mjs"), "--check"], { stdio: "ignore" })).not.toThrow();
  });
});
