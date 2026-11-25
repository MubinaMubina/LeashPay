import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ViemVaultGateway, createChainClients } from "./chain/viem-gateway";
import { loadConfig } from "./config";
import { Executor } from "./execution/executor";
import { Journal } from "./execution/journal";
import { RecipientDirectory } from "./plan/directory";
import { draftPlan } from "./plan/planner";

const config = loadConfig();
const { publicClient, walletClient } = createChainClients(config);
const gateway = new ViemVaultGateway(publicClient, walletClient, config.FACTORY_ADDRESS ?? null);
const journal = new Journal(path.join(config.DATA_DIR, "journal.jsonl"));
const directory = new RecipientDirectory(path.join(config.DATA_DIR, "recipients.json"));
const anthropic = new Anthropic(); // resolves ANTHROPIC_API_KEY (or an `ant auth login` profile)

const executor = new Executor({
  gateway,
  journal,
  tokenAddress: async (symbol) => {
    const deployment = await gateway.deployment();
    return symbol === "USDC" ? deployment.usdc : deployment.usdt;
  },
});

const app = createApp({
  gateway,
  planner: (input) => draftPlan(anthropic, config.ANTHROPIC_MODEL, input),
  directory,
  journal,
  executor,
  apiToken: config.AGENT_API_TOKEN,
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`LeashPay agent listening on http://localhost:${info.port}`);
  console.log(`  agent key:  ${gateway.agentAddress ?? "not set (AGENT_PRIVATE_KEY)"}`);
  console.log(`  factory:    ${config.FACTORY_ADDRESS ?? "not set yet (FACTORY_ADDRESS)"}`);
  console.log(`  model:      ${config.ANTHROPIC_MODEL}`);
});
