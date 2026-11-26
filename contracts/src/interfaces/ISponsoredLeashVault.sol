// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILeashVault} from "./ILeashVault.sol";

/// @notice The additional operations of a fee-charging LeashPay vault.
interface ISponsoredLeashVault is ILeashVault {
    /// @notice The vault transferred the USDT fee for this recipient and payment reference.
    event PaymentFeeCharged(address indexed recipient, address indexed token, uint256 amount, bytes32 indexed ref);

    error RecipientAlreadyAllowed(address recipient);
    error InvalidRecipientNonce(address recipient, uint256 expected, uint256 supplied);

    /// @notice Add a recipient using the owner's EIP-712 signature. Anyone may relay it.
    function addRecipientFor(
        address recipient,
        uint256 monthlyCap,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @notice Every successful direct or signed recipient change increments this value.
    function recipientNonce(address recipient) external view returns (uint256);

    /// @notice Each successful pay sends the full requested amount plus this fee from the vault.
    function paymentTerms() external view returns (address feeToken, address feeRecipient, uint256 feeAmount);
}
