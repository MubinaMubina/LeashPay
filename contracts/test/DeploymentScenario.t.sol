// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILeashVault} from "../src/interfaces/ILeashVault.sol";
import {ILeashVaultFactory} from "../src/interfaces/ILeashVaultFactory.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashVaultFactory} from "../src/LeashVaultFactory.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {MockDEX} from "../src/mocks/MockDEX.sol";
import {MockTBill} from "../src/mocks/MockTBill.sol";
import {AtlasRelayFeed} from "../src/AtlasRelayFeed.sol";

contract DeploymentScenarioTest is Test {
    function test_realDeploymentComponentsPayAndRejectReplay() public {
        vm.warp(100 days);
        MockToken t = new MockToken("Test USDT", "mUSDT");
        MockToken c = new MockToken("Test USDC", "mUSDC");
        AtlasRelayFeed ft = new AtlasRelayFeed(address(this), 18);
        AtlasRelayFeed fc = new AtlasRelayFeed(address(this), 18);
        ft.update(0.999e18, block.timestamp - 8 hours);
        fc.update(0.9998e18, block.timestamp - 9 hours);
        MockDEX dex = new MockDEX(address(t), address(c));
        MockTBill bill = new MockTBill(IERC20(address(t)));
        LeashVaultFactory factory = new LeashVaultFactory(
            ILeashVaultFactory.Config(
                address(t), address(c), address(ft), address(fc), 25 hours, address(bill), address(dex), address(123)
            )
        );
        LeashVault vault =
            LeashVault(factory.createVault(ILeashVault.Rules(500e18, 1000e18, 60, 200, 1000e18, 0.98e18)));
        vault.setRecipient(address(456), true, 1000e18);
        t.mint(address(vault), 1000e18);
        bytes32 ref = keccak256("sponsored-smoke-v1");
        vm.prank(address(123));
        vault.pay(address(456), address(t), 1e18, ref);
        assertEq(t.balanceOf(address(456)), 1e18);
        vm.expectRevert(abi.encodeWithSelector(ILeashVault.DuplicatePayment.selector, ref, address(456)));
        vm.prank(address(123));
        vault.pay(address(456), address(t), 1e18, ref);
        assertEq(t.balanceOf(address(456)), 1e18);
    }
}
