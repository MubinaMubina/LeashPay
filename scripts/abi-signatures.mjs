#!/usr/bin/env node
// Canonical ABI signatures for the LeashPay ABI freeze.
//
// Generate (prints sections to stdout, counts to stderr):
//   node scripts/abi-signatures.mjs ILeashVault=<abi.json> ILeashVaultFactory=<abi.json> ...
//
// Check an implementation against the frozen list (exit 1 if anything is missing):
//   node scripts/abi-signatures.mjs --check contracts/abi/frozen-signatures.txt \
//     ILeashVault=contracts/out/LeashVault.sol/LeashVault.json \
//     ILeashVaultFactory=contracts/out/LeashVaultFactory.sol/LeashVaultFactory.json
//
// Accepts a bare ABI array (solc --abi output) or a Foundry artifact ({ "abi": [...] }).
// A signature keeps every type, return type, state mutability and event `indexed`
// flag, so a changed type or indexing shows up as a missing line.
import { readFileSync } from "node:fs";

function loadAbi(path) {
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`${path}: file not found`);
    throw new Error(`${path}: not a JSON ABI (pass the compiled .json or .abi file, not the .sol source)`);
  }
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.abi)) return json.abi;
  throw new Error(`${path}: no ABI array found`);
}

function canonType(param) {
  if (param.type.startsWith("tuple")) {
    const arraySuffix = param.type.slice("tuple".length); // "" or "[]" or "[2]"
    return `(${param.components.map(canonType).join(",")})${arraySuffix}`;
  }
  return param.type;
}

function signature(item) {
  const inputs = (item.inputs ?? []).map(canonType).join(",");
  switch (item.type) {
    case "function": {
      const outputs = (item.outputs ?? []).map(canonType).join(",");
      return `function ${item.name}(${inputs}) ${item.stateMutability}${outputs ? ` returns (${outputs})` : ""}`;
    }
    case "event": {
      const params = item.inputs.map((i) => `${canonType(i)}${i.indexed ? " indexed" : ""}`).join(",");
      return `event ${item.name}(${params})${item.anonymous ? " anonymous" : ""}`;
    }
    case "error":
      return `error ${item.name}(${inputs})`;
    default:
      return null; // constructor, fallback and receive are implementation details
  }
}

function signatures(abi) {
  return [...new Set(abi.map(signature).filter(Boolean))].sort();
}

function parsePairs(args) {
  return args.map((arg) => {
    const eq = arg.indexOf("=");
    if (eq < 1) throw new Error(`expected Section=path, got "${arg}"`);
    return { section: arg.slice(0, eq), path: arg.slice(eq + 1) };
  });
}

function count(sigs) {
  const by = (kind) => sigs.filter((s) => s.startsWith(`${kind} `)).length;
  return `${by("function")} functions, ${by("event")} events, ${by("error")} errors`;
}

function generate(pairs) {
  const out = [];
  for (const { section, path } of pairs) {
    const sigs = signatures(loadAbi(path));
    out.push(`# ${section}`, ...sigs, "");
    console.error(`${section}: ${count(sigs)}`);
  }
  process.stdout.write(out.join("\n"));
}

function readFrozen(file) {
  const sections = new Map();
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("# ")) {
      current = line.slice(2).trim();
      sections.set(current, []);
    } else if (line.trim() && current) {
      sections.get(current).push(line.trim());
    }
  }
  return sections;
}

function check(frozenFile, pairs) {
  const frozen = readFrozen(frozenFile);
  let missing = 0;
  for (const { section, path } of pairs) {
    const expected = frozen.get(section);
    if (!expected) throw new Error(`section "${section}" not found in ${frozenFile}`);
    const actual = new Set(signatures(loadAbi(path)));
    const gaps = expected.filter((sig) => !actual.has(sig));
    for (const sig of gaps) console.log(`MISSING in ${section} (${path}): ${sig}`);
    if (gaps.length === 0) console.log(`OK ${section}: all ${expected.length} frozen signatures present`);
    missing += gaps.length;
  }
  process.exit(missing === 0 ? 0 : 1);
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: abi-signatures.mjs [--check frozen.txt] Section=abi.json ...");
    process.exit(2);
  }
  if (args[0] === "--check") check(args[1], parsePairs(args.slice(2)));
  else generate(parsePairs(args));
} catch (err) {
  console.error(`abi-signatures: ${err.message}`);
  process.exit(2);
}
