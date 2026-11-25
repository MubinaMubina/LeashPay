// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {MockDEX} from "../src/mocks/MockDEX.sol";
import {MockTBill} from "../src/mocks/MockTBill.sol";
import {AtlasRelayFeed} from "../src/AtlasRelayFeed.sol";

contract TestnetDependenciesTest is Test {
    function test_faucetMints18DecimalsWithPerCallCap() public {
        MockToken t = new MockToken("Test USDT", "mUSDT");
        t.mint(address(this), 1_000_000e18);
        assertEq(t.balanceOf(address(this)), 1_000_000e18);
        assertEq(t.decimals(), 18);
        vm.expectRevert(MockToken.InvalidMintAmount.selector);
        t.mint(address(this), 1_000_000e18 + 1);
        vm.expectRevert(MockToken.InvalidMintAmount.selector);
        t.mint(address(this), 0);
    }

    function test_dependenciesCannotDeployOnMainnet() public {
        vm.chainId(56);
        vm.expectRevert(MockToken.TestnetOnly.selector);
        new MockToken("Test", "T");
        vm.expectRevert(MockDEX.TestnetOnly.selector);
        new MockDEX(address(1), address(2));
        vm.expectRevert(MockTBill.TestnetOnly.selector);
        new MockTBill(IERC20(address(1)));
        vm.expectRevert(AtlasRelayFeed.TestnetOnly.selector);
        new AtlasRelayFeed(address(this), 8);
    }

    function test_dexUsesFundedLiquidityAndOnlyOwnerSetsRates() public {
        MockToken t = new MockToken("T", "T");
        MockToken c = new MockToken("C", "C");
        MockDEX d = new MockDEX(address(t), address(c));
        t.mint(address(this), 100e18);
        c.mint(address(d), 100e18);
        t.approve(address(d), 100e18);
        d.setRate(address(t), address(c), 0.99e18);
        assertEq(d.swap(address(t), address(c), 100e18), 99e18);
        assertEq(c.balanceOf(address(this)), 99e18);
        assertEq(t.balanceOf(address(d)), 100e18);
        vm.expectRevert(MockDEX.Unauthorized.selector);
        vm.prank(address(123));
        d.setRate(address(t), address(c), 1);
        vm.expectRevert(MockDEX.InvalidPair.selector);
        d.swap(address(t), address(t), 1);
    }

    function test_relayRequiresReporterAndPreservesSourceTimestamp() public {
        vm.warp(10000);
        AtlasRelayFeed f = new AtlasRelayFeed(address(this), 8);
        vm.expectRevert(abi.encodeWithSelector(AtlasRelayFeed.Unauthorized.selector, address(123)));
        vm.prank(address(123));
        f.update(1e8, 9999);
        f.update(99e6, 9999);
        (uint80 round, int256 answer, uint256 start, uint256 updated, uint80 answered) = f.latestRoundData();
        assertEq(round, 1);
        assertEq(answer, 99e6);
        assertEq(start, 9999);
        assertEq(updated, 9999);
        assertEq(answered, 1);
        vm.expectRevert(AtlasRelayFeed.InvalidUpdate.selector);
        f.update(1e8, 9998);
        vm.expectRevert(AtlasRelayFeed.InvalidUpdate.selector);
        f.update(0, 10000);
        vm.expectRevert(AtlasRelayFeed.InvalidUpdate.selector);
        f.update(1e8, 10001);
    }

    function test_mockBillYieldIsBackedByDonatedAssets() public {
        MockToken t = new MockToken("T", "T");
        MockTBill b = new MockTBill(IERC20(address(t)));
        t.mint(address(this), 100e18);
        t.approve(address(b), 100e18);
        b.deposit(100e18, address(this));
        t.mint(address(b), 10e18);
        assertGt(b.maxWithdraw(address(this)), 109e18);
        b.withdraw(109e18, address(this), address(this));
        assertEq(t.balanceOf(address(this)), 109e18);
    }
}
