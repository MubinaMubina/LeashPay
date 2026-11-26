import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { createApp } from "../src/app";
import { createChainClients, ViemVaultGateway } from "../src/chain/viem-gateway";
import { Executor } from "../src/execution/executor";
import { Journal } from "../src/execution/journal";
import { RecipientDirectory } from "../src/plan/directory";
import { ViemSponsorChain } from "../src/sponsor/chain";
import { SponsorshipService } from "../src/sponsor/service";

export const root = fileURLToPath(new URL("../../", import.meta.url));

export function artifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  return JSON.parse(readFileSync(path.join(root, "contracts/out", name + ".sol", name + ".json"), "utf8"));
}

export function signer(rpc: string, key: Hex) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: bscTestnet, transport: http(rpc) });
}

/** Every test gets its own chain, wallets, deployment and journal. No .env is read. */
export async function localFixture() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const { port } = address;
  await new Promise<void>((resolve, reject) => probe.close((err) => err ? reject(err) : resolve()));
  const bundled = path.join(root, ".setup/foundry-bin/anvil");
  const anvil = spawn(process.env.ANVIL || (existsSync(bundled) ? bundled : "anvil"), [
    "--host", "127.0.0.1", "--port", String(port), "--chain-id", "97", "--accounts", "0",
    "--block-time", "1", "--mixed-mining", "--slots-in-an-epoch", "1", "--gas-price", "100000000",
    "--block-base-fee-per-gas", "0", "--silent",
  ], { stdio: "ignore" });
  let startError: Error | undefined;
  anvil.once("error", (error) => { startError = error; });
  const interrupt = () => { dispose(); process.exit(130); };
  const terminate = () => { dispose(); process.exit(143); };
  const dispose = () => {
    anvil.kill();
    process.removeListener("exit", dispose);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
  process.once("exit", dispose);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const rpc = `http://127.0.0.1:${port}`;
  const deployKey = generatePrivateKey();
  const agentKey = generatePrivateKey();
  const { publicClient } = createChainClients({ BSC_TESTNET_RPC_URL: rpc });
  const admin = signer(rpc, deployKey);
  const sponsor = privateKeyToAccount(agentKey).address;
  try {
    let chainId = 0;
    const startupClient = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
    for (let i = 0; i < 50 && chainId === 0; i++) {
      if (startError) throw startError;
      if (anvil.exitCode !== null) throw new Error("Anvil exited during startup.");
      try { chainId = await startupClient.getChainId(); }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.equal(chainId, 97, "local test chain did not start");
    const dev = createTestClient({ mode: "anvil", transport: http(rpc) });
    for (const address of [admin.account.address, sponsor]) await dev.setBalance({ address, value: parseEther("1") });
    const deploy = async (name: string, args: readonly unknown[]) => {
      const { abi, bytecode } = artifact(name);
      const hash = await admin.deployContract({ abi, bytecode: bytecode.object, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", name);
      assert(receipt.contractAddress);
      return receipt.contractAddress;
    };
    const usdt = await deploy("MockToken", ["Mock USDT", "mUSDT"]);
    const usdc = await deploy("MockToken", ["Mock USDC", "mUSDC"]);
    const feed = await deploy("AtlasRelayFeed", [admin.account.address, 8]);
    const timestamp = (await publicClient.getBlock()).timestamp;
    const quote = await admin.writeContract({ address: feed, abi: artifact("AtlasRelayFeed").abi,
      functionName: "update", args: [100000000n, timestamp] });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: quote })).status, "success");
    const tbill = await deploy("MockTBill", [usdt]);
    const dex = await deploy("MockDEX", [usdt, usdc]);
    const config = { usdt, usdc, usdtFeed: feed, usdcFeed: feed, maxPriceAge: 90000n, tbill, dex, defaultAgent: sponsor };
    const factory = await deploy("SponsoredLeashVaultFactory", [config, admin.account.address]);
    return { rpc, deployKey, agentKey, factory, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Real relay, journal and executor. Only the natural-language draft is deterministic. */
export function flowApp(rpc: string, agentKey: Hex, factory: Address, data: string) {
  const { publicClient, walletClient } = createChainClients({ BSC_TESTNET_RPC_URL: rpc, AGENT_PRIVATE_KEY: agentKey });
  assert(walletClient);
  const gateway = new ViemVaultGateway(publicClient, walletClient, factory, true);
  const journal = new Journal(path.join(data, "journal.jsonl"));
  const directory = new RecipientDirectory(path.join(data, "recipients.json"));
  const sponsorship = new SponsorshipService(new ViemSponsorChain(publicClient, walletClient, factory), path.join(data, "sponsorships.json"));
  const app = createApp({ gateway, journal, directory, sponsor: sponsorship, executor: new Executor({ gateway, journal }),
    chat: async ({ message }) => ({ kind: "payment", message }),
    planner: async () => ({ kind: "payment", scheduled_for: "now", notes: [], payments: [
      { recipient_name: "Casey", recipient_address: "", amount: "20", currency: "USDT" },
    ] }),
  });
  return { app, publicClient, gateway, sponsor: walletClient.account.address };
}
