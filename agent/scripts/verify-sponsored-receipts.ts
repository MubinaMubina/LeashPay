import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BaseError, createPublicClient, decodeFunctionData, erc20Abi, formatEther, getAddress, http, isAddressEqual, parseAbi, parseEventLogs, parseUnits, zeroAddress, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { leashVaultAbi, leashVaultFactoryAbi } from "../src/abi/generated";
import { judgePayment } from "../src/chain/viem-gateway";

async function verify() {
  const env = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(env)) process.loadEnvFile(env);
  const manifest = JSON.parse(readFileSync(new URL("../../contracts/deployments/97-sponsored.json", import.meta.url), "utf8"));
  const { proof } = manifest;
  const client = createPublicClient({ chain: bscTestnet, transport: http(process.env.BSC_TESTNET_RPC_URL) });
  const archive = process.env.NODEREAL_API_KEY
    ? createPublicClient({ chain: bscTestnet, transport: http(`https://bsc-testnet.nodereal.io/v1/${process.env.NODEREAL_API_KEY}`) })
    : client;
  assert.equal(await client.getChainId(), 97);
  const vault = getAddress(proof.vault);
  const owner = getAddress(proof.owner);
  const recipient = getAddress(proof.recipient);
  const token = getAddress(manifest.usdt);
  const treasury = getAddress(manifest.treasury);
  const amount = parseUnits(proof.amountUSDT, 18);
  const fee = parseUnits(proof.feeUSDT, 18);
  const receiptFor = (hash: Hex) => client.getTransactionReceipt({ hash });
  const [deploy, activate, add, faucet, payment, finalized] = await Promise.all([
    receiptFor(manifest.factoryTransaction), receiptFor(proof.activate), receiptFor(proof.addRecipient),
    receiptFor(proof.faucet), receiptFor(proof.payment),
    client.getBlock({ blockTag: "finalized" }),
  ]);
  assert(deploy && activate && add && faucet && payment && finalized);
  for (const receipt of [deploy, activate, add, faucet, payment]) {
    assert.equal(receipt.status, "success");
    assert(receipt.blockNumber <= finalized.number);
  }
  assert(deploy.contractAddress && isAddressEqual(deploy.contractAddress, manifest.factory));
  assert(isAddressEqual(deploy.from, treasury));
  for (const receipt of [activate, add, payment]) assert(isAddressEqual(receipt.from, manifest.sponsor));
  assert(activate.to && isAddressEqual(activate.to, manifest.factory));
  assert(parseEventLogs({ abi: leashVaultFactoryAbi, eventName: "VaultCreated", logs: activate.logs }).some(log =>
    isAddressEqual(log.address, manifest.factory) && isAddressEqual(log.args.owner, owner) &&
    isAddressEqual(log.args.vault, vault) && isAddressEqual(log.args.agent, manifest.sponsor)));
  assert(add.to && isAddressEqual(add.to, vault));
  assert(parseEventLogs({ abi: leashVaultAbi, eventName: "RecipientUpdated", logs: add.logs }).some(log =>
    isAddressEqual(log.address, vault) && isAddressEqual(log.args.recipient, recipient) && log.args.allowed &&
    log.args.monthlyCap === parseUnits("1000", 18)));
  assert(parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: faucet.logs }).some(log =>
    isAddressEqual(log.address, token) && log.args.from === zeroAddress && isAddressEqual(log.args.to, vault) && log.args.value === amount + fee));
  const tx = await client.getTransaction({ hash: proof.payment });
  const call = decodeFunctionData({ abi: leashVaultAbi, data: tx.input });
  assert(call.functionName === "pay" && payment.to && isAddressEqual(payment.to, vault));
  const [to, paidToken, net, ref] = call.args;
  assert(isAddressEqual(to, recipient) && isAddressEqual(paidToken, token) && net === amount);
  const step = { recipient, token, amount, ref, fee: { token, amount: fee, treasury } };
  assert.equal(judgePayment(vault, step, payment).status, "paid");
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: payment.logs })
    .filter(log => isAddressEqual(log.address, token) && isAddressEqual(log.args.from, vault));
  assert.equal(transfers.length, 2);
  assert(transfers.some(log => isAddressEqual(log.args.to, recipient) && log.args.value === amount));
  assert(transfers.some(log => isAddressEqual(log.args.to, treasury) && log.args.value === fee));
  const terms = await client.readContract({ address: vault, abi: parseAbi(["function paymentTerms() view returns (address, address, uint256)"]), functionName: "paymentTerms" });
  assert(isAddressEqual(terms[0], token) && isAddressEqual(terms[1], treasury) && terms[2] === fee);
  for (const [label, receipt] of [["activation", activate], ["recipient", add], ["payment", payment]] as const) {
    const [balance, nonce] = await Promise.all([
      archive.getBalance({ address: owner, blockNumber: receipt.blockNumber }),
      archive.getTransactionCount({ address: owner, blockNumber: receipt.blockNumber }),
    ]);
    assert.equal(balance, 0n, label + ": owner tBNB");
    assert.equal(nonce, 0, label + ": owner transaction count");
    console.log(`${label}: owner held 0 tBNB; sponsor paid ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} tBNB.`);
  }
  console.log("Confirmed: 20 mUSDT to the recipient and 0.01 mUSDT to the treasury in one payment.");
}

verify().catch((error: unknown) => {
  if (error instanceof BaseError) {
    const missingState = /missing trie node|historical state|pruned/i.test(error.message);
    console.error(missingState ? "The RPC has pruned this block's state. Use an archive BSC testnet RPC for historical balances." :
      `BSC testnet verification failed (${error.name}).`);
  } else {
    console.error(error instanceof Error ? error.message : "Could not verify the recorded BSC testnet receipts.");
  }
  process.exitCode = 1;
});
