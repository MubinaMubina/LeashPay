// Checks the two demo shortcut messages against the real Claude planner before going on
// stage (D14): each runs 3 times and must produce the plan the demo depends on.
//
//   npm run check:demo
//
// Costs about 6 Claude calls. Reads the messages from web/lib/demo.ts, so the check can't
// drift from what the web app's chips send. Sends nothing on-chain.
import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getAddress, parseUnits, type Address } from "viem";
import { DEMO_ATTACK_ADDRESS, claudeApiKey, loadConfig } from "../src/config";
import { buildPlan, isExecutable } from "../src/plan/build";
import type { RecipientEntry } from "../src/plan/directory";
import { draftPlan } from "../src/plan/planner";

const RUNS = 3;
const OWNER = getAddress("0x000000000000000000000000000000000000dEaD");
const VAULT = getAddress("0x1df5aba120b14d2dd3878b876d9676c5a503b3d2");

const DIRECTORY: RecipientEntry[] = [
  { name: "Linh", address: getAddress("0x47D948f58f4a495283BF0F74257E2F73D446D7Ea"), country: "VN", currency: "VND" },
  { name: "Marco", address: getAddress("0xEBe6E66c61DC57185F2c9a63bbc9914B85A4b13B"), country: "PH", currency: "PHP" },
  { name: "Mai", address: getAddress("0x5eEccB731a3b642BFE93f0aaBe95AC74F5126B21"), country: "VN", currency: "VND" },
];

/** The chip texts, read from the web app so both always agree. */
function demoMessages(): { happyPath: string; attack: string } {
  const source = readFileSync(path.resolve(import.meta.dirname, "../../web/lib/demo.ts"), "utf8");
  const happyPath = /happyPath: "([^"]+)"/.exec(source)?.[1];
  const attack = /attack: `([^`]+)`/.exec(source)?.[1]?.replace("${DEMO_ATTACK_ADDRESS}", DEMO_ATTACK_ADDRESS);
  if (!happyPath || !attack) throw new Error("Couldn't find the demo messages in web/lib/demo.ts.");
  return { happyPath, attack };
}

const config = loadConfig();
const apiKey = claudeApiKey(config);
const anthropic = new Anthropic(apiKey ? { apiKey } : {});
const messages = demoMessages();

async function plan(message: string) {
  const draft = await draftPlan(anthropic, config.ANTHROPIC_MODEL, {
    message,
    directory: DIRECTORY,
    today: new Date().toISOString().slice(0, 10),
    balances: { USDT: "20000", USDC: "20000", tbill: "0" },
  });
  return buildPlan(draft, { id: "check", owner: OWNER, vault: VAULT, message, directory: DIRECTORY, now: new Date() });
}

const usd = (n: number) => parseUnits(String(n), 18);
const expectedHappy = new Map<Address, bigint>([
  [DIRECTORY[0]!.address, usd(300)],
  [DIRECTORY[1]!.address, usd(450)],
  [DIRECTORY[2]!.address, usd(200)],
]);

let failures = 0;
const fail = (what: string) => {
  failures++;
  console.log(`  ✗ ${what}`);
};

console.log(`Happy path: "${messages.happyPath}"`);
for (let run = 1; run <= RUNS; run++) {
  const p = await plan(messages.happyPath);
  const payable = p.payments.filter(isExecutable);
  const ok =
    payable.length === 3 &&
    payable.every((x) => expectedHappy.get(x.recipient) === x.amount && x.token === "USDT" && x.warnings.length === 0);
  if (ok) console.log(`  ✓ run ${run}: Linh 300, Marco 450, Mai 200, no warnings`);
  else fail(`run ${run}: ${payable.map((x) => `${x.recipientName} ${x.amount} ${x.token} [${x.warnings.join(" ")}]`).join("; ") || "nothing payable"}`);
}

console.log(`Attack: "${messages.attack}"`);
for (let run = 1; run <= RUNS; run++) {
  const p = await plan(messages.attack);
  const payable = p.payments.filter(isExecutable);
  const only = payable.length === 1 ? payable[0] : undefined;
  const ok = only !== undefined && only.recipient === DEMO_ATTACK_ADDRESS && only.amount > 0n && only.warnings.length > 0;
  if (ok) console.log(`  ✓ run ${run}: one flagged payment to the demo address (${only.warnings[0]})`);
  else fail(`run ${run}: ${payable.length} payable rows: ${payable.map((x) => `${x.recipient} ${x.amount}`).join("; ") || "none"}`);
}

if (failures > 0) {
  console.log(`\n${failures} of ${RUNS * 2} runs didn't give the plan the demo needs. Adjust the chip text in web/lib/demo.ts and run again.`);
  process.exit(1);
}
console.log(`\nAll ${RUNS * 2} runs gave the plans the demo needs.`);
