import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { selectChatCard } from "./chat";
import { ViemVaultGateway, createChainClients } from "./chain/viem-gateway";
import { claudeApiKey, isLoopback, loadConfig, localHostHeaders } from "./config";
import { Executor } from "./execution/executor";
import { Journal } from "./execution/journal";
import { lockDataDir } from "./execution/lock";
import { RecipientDirectory } from "./plan/directory";
import { createDepegGuard } from "./depeg/guard";
import { createFx } from "./fx/rates";
import { createBrainClient } from "./memory/brain";
import { createMemory } from "./memory/memory";
import { draftPlan } from "./plan/planner";
import { ViemSponsorChain } from "./sponsor/chain";
import { SponsorshipService } from "./sponsor/service";

const config = loadConfig();
lockDataDir(config.DATA_DIR); // one server per data folder
const { publicClient, walletClient } = createChainClients(config);
const gateway = new ViemVaultGateway(publicClient, walletClient, config.FACTORY_ADDRESS ?? null, Boolean(config.SPONSORED_FACTORY_ADDRESS));
const sponsor = config.SPONSORED_FACTORY_ADDRESS && walletClient
  ? new SponsorshipService(new ViemSponsorChain(publicClient, walletClient, config.SPONSORED_FACTORY_ADDRESS), path.join(config.DATA_DIR, "sponsorships.json"))
  : undefined;
const journal = new Journal(path.join(config.DATA_DIR, "journal.jsonl"));
const directory = new RecipientDirectory(path.join(config.DATA_DIR, "recipients.json"));
const apiKey = claudeApiKey(config);
const anthropic = new Anthropic(apiKey ? { apiKey } : {}); // no key: the SDK tries an `ant auth login` profile
const executor = new Executor({ gateway, journal });
const local = isLoopback(config.AGENT_HOST);
const brain =
  config.LIVING_BRAIN_API_KEY && config.LIVING_BRAIN_BRAIN_ID && config.LIVING_BRAIN_SUBJECT_ID
    ? createBrainClient({ apiKey: config.LIVING_BRAIN_API_KEY, brainId: config.LIVING_BRAIN_BRAIN_ID, subjectId: config.LIVING_BRAIN_SUBJECT_ID })
    : null;

const app = createApp({
  gateway,
  sponsor,
  planner: (input) => draftPlan(anthropic, config.ANTHROPIC_MODEL, input),
  chat: (input) => selectChatCard(anthropic, config.ANTHROPIC_MODEL, input),
  directory,
  journal,
  executor,
  apiToken: config.AGENT_API_TOKEN,
  // Only this machine can connect, so only its own names are valid in the Host header.
  allowedHosts: local ? localHostHeaders(config) : undefined,
  demoAttack: config.AGENT_DEMO_ATTACK === "1",
  depeg: createDepegGuard({ apiKey: config.COURNOT_API_KEY }),
  fx: config.CMC_API_KEY ? createFx({ apiKey: config.CMC_API_KEY }) : undefined,
  memory: brain ? createMemory({ client: brain }) : undefined,
});

serve({ fetch: app.fetch, port: config.PORT, hostname: config.AGENT_HOST }, (info) => {
  const host = config.AGENT_HOST.includes(":") ? `[${config.AGENT_HOST}]` : config.AGENT_HOST;
  const where = local ? `http://${host}:${info.port} (this machine only)` : `http://${host}:${info.port}`;
  console.log(`LeashPay agent listening on ${where}`);
  console.log(`  agent key:  ${gateway.agentAddress ?? "not set (AGENT_PRIVATE_KEY)"}`);
  console.log(`  factory:    ${config.FACTORY_ADDRESS ?? "not set yet (FACTORY_ADDRESS)"}`);
  console.log(`  model:      ${config.ANTHROPIC_MODEL}`);
  console.log(`  local fx:   ${config.CMC_API_KEY ? "CoinMarketCap" : "off (CMC_API_KEY not set)"}`);
  console.log(`  memory:     ${brain ? "Living Brain" : "off (LIVING_BRAIN_* not all set)"}`);
  if (!config.ANTHROPIC_API_KEY && config.LLM_API_KEY) {
    console.log("  note:       using LLM_API_KEY; rename it to ANTHROPIC_API_KEY in .env");
  }
});

// Exit through process.exit on Ctrl-C or a restart, so the data-folder lock is released.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(0));
