import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { erc20Abi, formatEther, formatUnits, getAddress, isAddressEqual, parseAbi, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { flowApp, localFixture, root, signer } from "./sponsored-fixture";

const amount = parseUnits("20", 18);
const fee = parseUnits("0.01", 18);
const stableAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const feeEvents = parseAbi(["event PaymentFeeCharged(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed ref)"]);

async function publicFixture(factory: Address) {
  process.loadEnvFile(path.join(root, ".env"));
  const rpc = process.env.BSC_TESTNET_RPC_URL;
  const deployKey = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  const agentKey = process.env.AGENT_PRIVATE_KEY as Hex;
  assert(rpc && deployKey && agentKey, "Missing BSC testnet RPC or signer");
  const legacy = JSON.parse(readFileSync(path.join(root, "contracts/deployments/97.json"), "utf8"));
  const sponsored = JSON.parse(readFileSync(path.join(root, "contracts/deployments/97-sponsored.json"), "utf8"));
  assert(isAddressEqual(factory, sponsored.factory), "Use the recorded isolated testnet factory");
  assert(isAddressEqual(privateKeyToAccount(deployKey).address, legacy.deployer));
  assert(isAddressEqual(privateKeyToAccount(agentKey).address, legacy.agent));
  return { rpc, deployKey, agentKey, factory, dispose() {} };
}

async function run() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === "--testnet"), "Use no arguments for Anvil, or --testnet <sponsored factory> for a public test.");
  const fixture = args[1] ? await publicFixture(getAddress(args[1])) : await localFixture();
  const dir = mkdtempSync(path.join(tmpdir(), "leashpay-sponsored-test-"));
  try {
    const { rpc, deployKey, agentKey, factory } = fixture;
    const admin = signer(rpc, deployKey);
    const { app, publicClient, gateway, sponsor } = flowApp(rpc, agentKey, factory, dir);
    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 97, "Refusing to broadcast outside chain 97");
    const { usdt, defaultAgent } = await gateway.deployment();
    assert(isAddressEqual(defaultAgent, sponsor));
    const owner = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const balances = (address: Address, blockNumber?: bigint) => publicClient.readContract({ address: usdt, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber });
    const atZero = async () => {
      assert.equal(await publicClient.getBalance({ address: owner.address, blockTag: "latest" }), 0n, "owner paid native gas");
      assert.equal(await publicClient.getTransactionCount({ address: owner.address, blockTag: "latest" }), 0, "owner sent a transaction");
    };
    const request = (route: string, body?: unknown) => app.request(route, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    async function read<T>(route: string, body?: unknown): Promise<T> {
      const res = await request(route, body);
      const result = await res.json();
      assert(res.ok, route + ": " + JSON.stringify(result));
      return result as T;
    }
    const receipts: Record<string, Hex> = {};
    const gasPaid: Record<string, string> = {};
    const relay = async (action: "activate" | "addRecipient", fields: Record<string, string> = {}) => {
      const intent = { action, owner: owner.address, ...fields };
      type Challenge = { typedData: Parameters<typeof owner.signTypedData>[0]; deadline: string; nonce?: string };
      const { typedData, deadline, nonce } = await read<Challenge>("/sponsor/prepare", intent);
      const signed = { ...intent, deadline, ...(nonce === undefined ? {} : { nonce }), signature: await owner.signTypedData(typedData) };
      const result = await read<{ hash: Hex; vault: Address }>("/sponsor/execute", signed);
      assert(result.hash, "expected first broadcast");
      const receipt = await publicClient.getTransactionReceipt({ hash: result.hash });
      assert.equal(receipt.status, "success");
      assert(isAddressEqual(receipt.from, sponsor));
      receipts[action] = result.hash;
      gasPaid[action] = formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
      await atZero();
      const count = await publicClient.getTransactionCount({ address: sponsor, blockTag: "pending" });
      const retry = await read<{ vault: Address }>("/sponsor/execute", signed);
      assert(isAddressEqual(retry.vault, result.vault));
      assert.equal(await publicClient.getTransactionCount({ address: sponsor, blockTag: "pending" }), count, "retry spent more gas");
      console.log(`${action}: sponsor paid the gas; wallet balance and nonce are zero. Repeat sent no transaction.`);
      return result.vault;
    };
    await atZero();
    const vault = await relay("activate");
    assert(isAddressEqual((await gateway.vaultOf(owner.address))!, vault));
    const terms = await gateway.paymentFee(vault);
    assert(terms && terms.amount === fee.toString() && isAddressEqual(terms.recipient, admin.account.address));
    await relay("addRecipient", { recipient, monthlyCap: parseUnits("1000", 18).toString() });
    assert(await gateway.isAllowed(vault, recipient));
    await read("/directory", { owner: owner.address, address: recipient, name: "Casey", createOnly: true });
    const mint = await admin.writeContract({ address: usdt, abi: stableAbi, functionName: "mint", args: [vault, amount + fee] });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: mint })).status, "success");
    receipts.faucet = mint;
    const message = "Pay Casey 20 USDT";
    const plan = await read<{ id: string; ref: Hex; paymentFee: typeof terms; payments: { preview: unknown }[] }>("/plans", { owner: owner.address, message });
    assert.deepEqual(plan.paymentFee, terms);
    assert.deepEqual(plan.payments.map(p => p.preview), [null], "the payment must pass the vault simulation");
    const approval = await read<{ message: string; expires: string; payEarly: boolean }>(`/plans/${plan.id}/approval`);
    assert(approval.message.includes("Maximum service fees: 0.01 USDT") && approval.message.includes("Maximum vault debit: 20.01 USDT"));
    const omittedFee = approval.message.split("\n").filter(line => !/^(Service fee|Maximum service fees|Maximum vault debit):/.test(line)).join("\n");
    const incomplete = await request(`/plans/${plan.id}/execute`, {
      expires: approval.expires, payEarly: approval.payEarly, signature: await owner.signMessage({ message: omittedFee }),
    });
    assert.equal(incomplete.status, 401, "the V2 owner must sign both the payout and the fee");
    assert.equal(await balances(vault), amount + fee, "an incomplete approval moved funds");
    assert.equal(await publicClient.readContract({ address: usdt, abi: erc20Abi, functionName: "allowance",
      args: [vault, terms.recipient] }), 0n, "expected no token allowance for the treasury");
    console.log("Signing only the payout was refused. Vault balance stayed at 20.01 USDT and treasury allowance at zero.");
    console.log("Before signing: Casey receives 20 USDT; service fee 0.01 USDT; maximum debit 20.01 USDT.");
    const signed = { expires: approval.expires, payEarly: approval.payEarly, signature: await owner.signMessage({ message: approval.message }) };
    type Run = { results: { status: string; hash?: Hex }[] };
    const payment = (await read<Run>(`/plans/${plan.id}/execute`, signed)).results[0];
    assert(payment?.status === "paid" && payment.hash, "payment did not finalize: " + payment?.status);
    const receipt = await publicClient.getTransactionReceipt({ hash: payment.hash });
    assert.equal(receipt.status, "success");
    assert(isAddressEqual(receipt.from, sponsor) && receipt.to && isAddressEqual(receipt.to, vault));
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
      .filter(l => isAddressEqual(l.address, usdt) && isAddressEqual(l.args.from, vault));
    assert.equal(transfers.length, 2);
    assert(transfers.some(l => isAddressEqual(l.args.to, recipient) && l.args.value === amount));
    assert(transfers.some(l => isAddressEqual(l.args.to, terms.recipient) && l.args.value === fee));
    assert(parseEventLogs({ abi: feeEvents, eventName: "PaymentFeeCharged", logs: receipt.logs }).some(l =>
      isAddressEqual(l.address, vault) && isAddressEqual(l.args.recipient, recipient) && isAddressEqual(l.args.token, usdt) && l.args.amount === fee && l.args.ref === plan.ref));
    for (const [account, delta] of [[vault, -amount - fee], [recipient, amount], [terms.recipient, fee]] as const) {
      assert.equal(await balances(account, receipt.blockNumber) - await balances(account, receipt.blockNumber - 1n), delta);
    }
    const repeated = await request(`/plans/${plan.id}/execute`, signed);
    assert.equal(repeated.status, 401);
    await atZero();
    receipts.payment = payment.hash;
    gasPaid.payment = formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
    console.log("Confirmed two token transfers in one payment. Reusing the approval was refused.");
    console.log(JSON.stringify({ network: args.length ? "BSC testnet" : "local Anvil", chainId, factory, vault, owner: owner.address,
      ownerTBNB: "0", ownerTransactionCount: 0, sponsor, recipient, treasury: terms.recipient, recipientUSDT: formatUnits(amount, 18),
      feeUSDT: formatUnits(fee, 18), debitUSDT: formatUnits(amount + fee, 18), receipts, gasPaidTBNB: gasPaid }, null, 2));
  } finally {
    fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  // RPC errors can contain provider credentials or raw signed transactions.
  if (error instanceof Error && (error.name === "AssertionError" || !process.argv.includes("--testnet"))) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.name : "Test failed");
  }
  process.exitCode = 1;
});
