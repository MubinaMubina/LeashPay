// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Owner approvals are scoped to the chain and to the factory or vault receiving the call.
abstract contract LeashOwnerAuthorization is EIP712 {
    error AuthorizationExpired(uint256 deadline);
    error InvalidOwnerSignature();

    constructor() EIP712("LeashPay", "2") {}

    function _verifyOwnerAuthorization(address owner, bytes32 structHash, uint256 deadline, bytes calldata signature)
        internal
        view
    {
        if (block.timestamp > deadline) revert AuthorizationExpired(deadline);
        bytes32 digest = _hashTypedDataV4(structHash);
        // Use the Paris-compatible ECDSA and ERC-1271 paths. The bundled SignatureChecker also imports Cancun MCOPY.
        if (owner.code.length == 0) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            if (err == ECDSA.RecoverError.NoError && signer == owner) return;
        } else {
            (bool ok, bytes memory result) =
                owner.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            if (
                ok && result.length >= 32
                    && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector)
            ) return;
        }
        revert InvalidOwnerSignature();
    }
}
