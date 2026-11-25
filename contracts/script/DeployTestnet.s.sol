// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILeashVaultFactory} from "../src/interfaces/ILeashVaultFactory.sol";
import {LeashVaultFactory} from "../src/LeashVaultFactory.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {MockDEX} from "../src/mocks/MockDEX.sol";
import {MockTBill} from "../src/mocks/MockTBill.sol";
import {AtlasRelayFeed} from "../src/AtlasRelayFeed.sol";

contract DeployTestnet is Script {
    function run() external returns (LeashVaultFactory factory) {
        require(block.chainid == 97, "BSC testnet only");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address agent = vm.envAddress("AGENT_ADDRESS");
        address reporter = vm.envAddress("REPORTER_ADDRESS");
        require(
            agent != address(0) && reporter != address(0) && reporter != agent && deployer != agent
                && deployer != reporter,
            "Separate roles required"
        );
        vm.startBroadcast(key);
        MockToken usdt = new MockToken("LeashPay Mock USDT", "mUSDT");
        MockToken usdc = new MockToken("LeashPay Mock USDC", "mUSDC");
        AtlasRelayFeed usdtFeed = new AtlasRelayFeed(reporter, 18);
        AtlasRelayFeed usdcFeed = new AtlasRelayFeed(reporter, 18);
        MockTBill bill = new MockTBill(IERC20(address(usdt)));
        MockDEX dex = new MockDEX(address(usdt), address(usdc));
        // Free Atlas push feeds advertise a 24-hour heartbeat. Keep the original
        // source timestamp and allow one hour for delivery, never rewrite time.
        factory = new LeashVaultFactory(
            ILeashVaultFactory.Config(
                address(usdt),
                address(usdc),
                address(usdtFeed),
                address(usdcFeed),
                25 hours,
                address(bill),
                address(dex),
                agent
            )
        );
        usdt.mint(address(dex), 100_000e18);
        usdc.mint(address(dex), 100_000e18);
        vm.stopBroadcast();
        string memory keyJson = "deployment";
        vm.serializeUint(keyJson, "chainId", 97);
        vm.serializeString(keyJson, "status", "prepared; confirm receipts before use");
        vm.serializeAddress(keyJson, "deployer", deployer);
        vm.serializeAddress(keyJson, "agent", agent);
        vm.serializeAddress(keyJson, "reporter", reporter);
        vm.serializeAddress(keyJson, "factory", address(factory));
        vm.serializeAddress(keyJson, "usdt", address(usdt));
        vm.serializeAddress(keyJson, "usdc", address(usdc));
        vm.serializeAddress(keyJson, "usdtFeed", address(usdtFeed));
        vm.serializeAddress(keyJson, "usdcFeed", address(usdcFeed));
        vm.serializeAddress(keyJson, "tbill", address(bill));
        vm.serializeAddress(keyJson, "dex", address(dex));
        string memory output = vm.serializeUint(keyJson, "maxPriceAge", 25 hours);
        vm.writeJson(output, "deployments/97.json");
    }
}
