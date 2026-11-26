import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestClient, erc20Abi, http, isAddressEqual, parseAbi, parseEventLogs, parseEther, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { leashVaultAbi, leashVaultFactoryAbi } from "../src/abi/generated";
import { DEMO_RULES } from "../src/sponsor/authorization";
import { flowApp, localFixture, signer } from "./sponsored-fixture";

type App = ReturnType<typeof flowApp>["app"];
function request(app: App, url: string, body?: unknown) {
  return app.request(url, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function json<T>(app: App, route: string, body?: unknown) {
  const response = await request(app, route, body);
  const result = await response.json();
  assert(response.ok, route + ": " + JSON.stringify(result));
  return result as T;
}

async function run() {
  const fixture = await localFixture();
  const dir = mkdtempSync(path.join(tmpdir(), "leashpay-returning-account-"));
  try {
    const { rpc, agentKey, deployKey, factory } = fixture;
    const legacyFactory = await fixture.deployLegacyFactory();
    const old = flowApp(rpc, agentKey, legacyFactory, dir, { sponsored: false });
    const { publicClient } = old;
    const dev = createTestClient({ mode: "anvil", transport: http(rpc) });
    const owner = signer(rpc, generatePrivateKey());
    const wallet = owner.account.address;
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const admin = signer(rpc, deployKey);
    const { usdt } = await old.gateway.deployment();
    const amount = parseUnits("20", 18);
    const confirmed = async (hash: Hex) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    // Reproduce a pre-upgrade account with an already funded vault and an approved recipient.
    await dev.setBalance({ address: wallet, value: parseEther("1") });
    await confirmed(await owner.writeContract({ address: legacyFactory, abi: leashVaultFactoryAbi, functionName: "createVault", args: [DEMO_RULES] }));
    const vault = await old.gateway.vaultOf(wallet);
    assert(vault);
    await confirmed(await owner.writeContract({ address: vault, abi: leashVaultAbi, functionName: "setRecipient", args: [recipient, true, DEMO_RULES.perPaymentCap] }));
    await confirmed(await admin.writeContract({ address: usdt, abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [vault, amount] }));
    await json(old.app, "/directory", { owner: wallet, name: "Casey", address: recipient, createOnly: true });
    await dev.setBalance({ address: wallet, value: 0n });
    const ownerNonce = await publicClient.getTransactionCount({ address: wallet });
    const message = { owner: wallet, message: "Pay Casey 20 USDT" };
    type Plan = { id: string; vault: Address; paymentFee?: unknown };
    const previous = await json<Plan>(old.app, "/plans", message);
    assert.equal(previous.paymentFee, undefined);
    const approval = await json<{ message: string; expires: string; payEarly: boolean }>(old.app, `/plans/${previous.id}/approval`);
    const signature = await owner.account.signMessage({ message: approval.message });

    // Restart with V2 active and the same directory and journal. The signing wallet is unchanged.
    const { app, sponsor } = flowApp(rpc, agentKey, factory, dir, { legacyFactory });
    const snapshot = await json<{ vault: Address; balances: { USDT: string } }>(app, `/vaults/${wallet}`);
    assert(isAddressEqual(snapshot.vault, vault) && snapshot.balances.USDT === String(amount));
    const entries = await json<{ address: Address }[]>(app, `/directory?owner=${wallet}`);
    assert(entries.some(entry => isAddressEqual(entry.address, recipient)));
    const fresh = await json<Plan>(app, "/plans", message);
    assert(isAddressEqual(fresh.vault, vault) && fresh.paymentFee === undefined);
    assert.equal((await request(app, "/sponsor/prepare", { action: "activate", owner: wallet })).status, 409);
    const balance = (address: Address) => publicClient.readContract({ address: usdt, abi: erc20Abi, functionName: "balanceOf", args: [address] });
    const treasuryBefore = await balance(admin.account.address);
    const submit = { expires: approval.expires, payEarly: approval.payEarly, signature };
    const run = await json<{ results: { status: string; hash: Hex }[] }>(app, `/plans/${previous.id}/execute`, submit);
    const result = run.results[0];
    assert(result?.status === "paid");
    const receipt = await confirmed(result.hash);
    const outgoing = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
      .filter(log => isAddressEqual(log.address, usdt) && isAddressEqual(log.args.from, vault));
    assert.equal(outgoing.length, 1);
    assert(isAddressEqual(outgoing[0]!.args.to, recipient) && outgoing[0]!.args.value === amount);
    assert(isAddressEqual(receipt.from, sponsor));
    assert.equal(await balance(vault), 0n);
    assert.equal(await balance(recipient), amount);
    assert.equal(await balance(admin.account.address), treasuryBefore);
    assert.equal(await publicClient.readContract({ address: factory, abi: leashVaultFactoryAbi, functionName: "vaultOf", args: [wallet] }), zeroAddress);
    assert.equal(await publicClient.getBalance({ address: wallet }), 0n);
    assert.equal(await publicClient.getTransactionCount({ address: wallet }), ownerNonce);
    assert.equal((await request(app, `/plans/${previous.id}/execute`, submit)).status, 401);
    console.log("Returning owner reopened the original vault, balance and recipient. A new plan kept the same fee-free terms.");
    console.log("The previously signed V1 plan paid 20 mUSDT once. Treasury delta: 0. Owner gas: 0. No second vault was created.");
  } finally {
    fixture.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error instanceof Error ? error.message : "Returning-account test failed"); process.exitCode = 1; });
