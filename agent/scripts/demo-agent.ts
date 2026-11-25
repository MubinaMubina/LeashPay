import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { formatUnits, getAddress, parseUnits } from "viem";
import roster from "../../contracts/deployments/97-demo-recipients.json" with { type: "json" };
import deployment from "../../contracts/deployments/97.json" with { type: "json" };
import { claudeApiKey, ConfigurationError, loadConfig } from "../src/config";
import { buildPlan } from "../src/plan/build";
import { RecipientEntrySchema } from "../src/plan/directory";
import { draftPlan, PlannerError, type PlannerInput } from "../src/plan/planner";
import type { PlanDraft } from "../src/plan/schema";

class DemoError extends Error {}

export async function planDemo(planner: (input: PlannerInput) => Promise<PlanDraft>, marcoOnly: boolean) {
  if (deployment.status !== "confirmed" || deployment.chainId !== 97 || roster.chainId !== 97 ||
      getAddress(roster.token) !== getAddress(deployment.usdt) || roster.paymentPerRecipientTokens !== 1) {
    throw new DemoError("Vérifiez le réseau et le contrat mUSDT dans les fichiers de déploiement de la chaîne 97.");
  }
  const directory = roster.recipients.map((person) => RecipientEntrySchema.parse(person));
  if (directory.length !== 3 || !["Linh", "Marco", "Mai"].every((name) => directory.some((p) => p.name === name)) ||
      new Set(directory.map((p) => p.address)).size !== 3) {
    throw new DemoError("Le carnet de démo doit contenir trois adresses distinctes pour Linh, Marco et Mai.");
  }

  const expected = marcoOnly ? directory.filter((p) => p.name === "Marco") : directory;
  const message = `Paie ${expected.map((p) => `1 USDT à ${p.name}`).join(", ")}.`;
  const now = new Date();
  const draft = await planner({ message, directory, today: now.toISOString().slice(0, 10) });
  const vault = getAddress(roster.vault);
  const plan = buildPlan(draft, { id: randomUUID(), owner: getAddress(deployment.deployer), vault, message, directory, now });
  if (plan.kind !== "payment" || plan.scheduledFor !== "now" || plan.payments.length !== expected.length) {
    throw new DemoError("Le plan doit proposer un paiement immédiat par destinataire demandé. Vérifiez le plan avant de réessayer.");
  }
  const payments = expected.map((entry) => {
    const match = plan.payments.find((p) => p.recipient === entry.address && p.recipientName === entry.name);
    if (!match || match.warnings.length || match.amount !== parseUnits("1", 18) || match.token !== "USDT") {
      throw new DemoError(`Le plan ne valide pas 1 mUSDT à l’adresse de ${entry.name}. Vérifiez le montant, le jeton et le carnet de démo.`);
    }
    return { name: match.recipientName, address: match.recipient, amount: match.amount.toString() };
  });
  return { chainId: roster.chainId, vault, token: getAddress(roster.token), payments };
}

function errorMessage(err: unknown): string {
  if (err instanceof DemoError) return err.message;
  if (err instanceof ConfigurationError) return "Renseignez ANTHROPIC_API_KEY (ou LLM_API_KEY) dans le .env à la racine.";
  if (err instanceof PlannerError) return "Claude n’a pas produit de plan exploitable. Relancez le test de planification.";
  if (err instanceof APIConnectionError) return "Connexion à Anthropic impossible. Vérifiez le réseau et réessayez.";
  if (err instanceof APIError) {
    switch (err.status) {
      case 401: case 403: return `Anthropic HTTP ${err.status}. Vérifiez la clé API et ses droits d’accès au modèle.`;
      case 400: case 402: case 404: return `Anthropic HTTP ${err.status}. Vérifiez le modèle ANTHROPIC_MODEL et les crédits du compte.`;
      default: return `Anthropic HTTP ${err.status}. Vérifiez la disponibilité du service et réessayez.`;
    }
  }
  return "Planification impossible. Vérifiez le .env à la racine et les fichiers de déploiement de la chaîne 97.";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--marco" && arg !== "--json")) {
    throw new DemoError("Options disponibles : --marco pour un seul destinataire, --json pour la sortie machine.");
  }
  const config = loadConfig();
  const client = new Anthropic({ apiKey: claudeApiKey(config), baseURL: "https://api.anthropic.com", logLevel: "off" });
  const result = await planDemo((input) => draftPlan(client, config.ANTHROPIC_MODEL, input), args.includes("--marco"));
  if (args.includes("--json")) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log("Claude a préparé le plan suivant pour le coffre BSC testnet (chaîne 97) :");
  for (const p of result.payments) console.log(`  ${p.name} → ${p.address} · ${formatUnits(BigInt(p.amount), 18)} mUSDT`);
  console.log(`Total prévu : ${result.payments.length} mUSDT. Aucune transaction signée ou envoyée.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exitCode = 1;
  });
}
