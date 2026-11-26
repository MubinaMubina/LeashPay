import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ViemVaultGateway, createChainClients } from "./chain/viem-gateway";
import { claudeApiKey, isLoopback, loadConfig, localHostHeaders } from "./config";
import { Executor } from "./execution/executor";
import { Journal } from "./execution/journal";
import { lockDataDir } from "./execution/lock";
import { RecipientDirectory } from "./plan/directory";
import { createDepegGuard } from "./depeg/guard";
import { createFx } from "./fx/rates";
import { draftPlan } from "./plan/planner";

const config = loadConfig();
lockDataDir(config.DATA_DIR); // one server per data folder
const { publicClient, walletClient } = createChainClients(config);
const gateway = new ViemVaultGateway(publicClient, walletClient, config.FACTORY_ADDRESS ?? null);
const journal = new Journal(path.join(config.DATA_DIR, "journal.jsonl"));
const directory = new RecipientDirectory(path.join(config.DATA_DIR, "recipients.json"));
const apiKey = claudeApiKey(config);
const anthropic = new Anthropic(apiKey ? { apiKey } : {}); // no key: the SDK tries an `ant auth login` profile
const executor = new Executor({ gateway, journal });
const local = isLoopback(config.AGENT_HOST);

const app = createApp({
  gateway,
  planner: (input) => draftPlan(anthropic, config.ANTHROPIC_MODEL, input),
  directory,
  journal,
  executor,
  apiToken: config.AGENT_API_TOKEN,
  // Only this machine can connect, so only its own names are valid in the Host header.
  allowedHosts: local ? localHostHeaders(config) : undefined,
  demoAttack: config.AGENT_DEMO_ATTACK === "1",
  depeg: createDepegGuard({ apiKey: config.COURNOT_API_KEY }),
  fx: config.CMC_API_KEY ? createFx({ apiKey: config.CMC_API_KEY }) : undefined,
});

serve({ fetch: app.fetch, port: config.PORT, hostname: config.AGENT_HOST }, (info) => {
  const host = config.AGENT_HOST.includes(":") ? `[${config.AGENT_HOST}]` : config.AGENT_HOST;
  const where = local ? `http://${host}:${info.port} (this machine only)` : `http://${host}:${info.port}`;
  console.log(`LeashPay agent listening on ${where}`);
  console.log(`  agent key:  ${gateway.agentAddress ?? "not set (AGENT_PRIVATE_KEY)"}`);
  console.log(`  factory:    ${config.FACTORY_ADDRESS ?? "not set yet (FACTORY_ADDRESS)"}`);
  console.log(`  model:      ${config.ANTHROPIC_MODEL}`);
  console.log(`  local fx:   ${config.CMC_API_KEY ? "CoinMarketCap" : "off (CMC_API_KEY not set)"}`);
  if (!config.ANTHROPIC_API_KEY && config.LLM_API_KEY) {
    console.log("  note:       using LLM_API_KEY; rename it to ANTHROPIC_API_KEY in .env");
  }
});

// Exit through process.exit on Ctrl-C or a restart, so the data-folder lock is released.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(0));
