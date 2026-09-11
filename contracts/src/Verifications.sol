// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Sovereign Verifications
/// @notice One human, one account — recorded on-chain so buyers can see it.
///
/// World ID proves personhood, but the proof was only ever checked on our server
/// and stashed in the verifier's own browser. That made the guarantee invisible
/// to the people it exists for: a buyer looking at a seller's profile had no way
/// to tell a verified human from anyone else. This contract is where that fact
/// becomes public.
///
/// TRUST MODEL — read before quoting this as proof of anything:
/// Arc has no World ID router, so the Semaphore proof cannot be verified here.
/// What this contract verifies is that `attestor` — our relying-party server,
/// which did check the proof against World's Developer Portal, bound it to our
/// action, and bound it to this exact account — signed off on this record. It is
/// an attestation bridge, not on-chain zero-knowledge verification. A buyer is
/// trusting World for the personhood and us for the relay. What it is NOT is
/// self-asserted: nobody can write their own badge, which is what the previous
/// localStorage version amounted to.
///
/// Two things the chain does enforce on its own, which the server could not:
///  - one nullifier maps to one account, permanently. The server's replay guard
///    was an in-memory Map on a serverless instance, so it forgot everything on
///    a cold start and could not see other instances. This cannot forget.
///  - an attestation names its account, so a signature handed to someone else is
///    worthless to them.
contract Verifications {
    struct Record {
        bytes32 nullifier; // World ID nullifier for our action — the human's pseudonym
        string level;      // credential used, e.g. "selfie"
        uint64 at;
    }

    /// The key our relying-party server signs attestations with.
    address public attestor;
    /// May rotate `attestor`. Rotation is forward-only: records already written stand.
    address public owner;

    mapping(address => Record) public records;
    /// nullifier => the one account that claimed it. The Sybil guard.
    mapping(bytes32 => address) public claimedBy;

    uint256 public count;

    event Verified(address indexed account, bytes32 indexed nullifier, string level, uint64 at);
    event AttestorChanged(address indexed previous, address indexed next);

    error NotOwner();
    error BadSignature();
    error Expired();
    error NullifierTaken(address holder);
    error AlreadyVerified();
    error ZeroAddress();
    error ZeroNullifier();

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address account,bytes32 nullifier,string level,uint256 deadline)");

    bytes32 private immutable _domainSeparator;

    constructor(address attestor_) {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        owner = msg.sender;
        _domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SovereignVerifications"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    /// @notice Record that the caller is a verified unique human.
    /// @dev The caller submits their own attestation and pays their own gas, so
    ///      the server never needs a funded hot wallet that can run dry mid-demo.
    /// @param nullifier World ID nullifier hash for our action
    /// @param level the credential World used, e.g. "selfie"
    /// @param deadline unix seconds after which the signature is refused
    /// @param signature 65-byte secp256k1 signature from `attestor` over the EIP-712 digest
    function attest(bytes32 nullifier, string calldata level, uint256 deadline, bytes calldata signature)
        external
    {
        // The nullifier doubles as the "has a record" sentinel below, so a zero one
        // would read as no record at all. World never issues one; refuse it anyway
        // rather than store a row that can never be seen.
        if (nullifier == bytes32(0)) revert ZeroNullifier();
        if (block.timestamp > deadline) revert Expired();
        if (records[msg.sender].nullifier != bytes32(0)) revert AlreadyVerified();

        address holder = claimedBy[nullifier];
        if (holder != address(0)) revert NullifierTaken(holder);

        bytes32 structHash = keccak256(
            abi.encode(ATTESTATION_TYPEHASH, msg.sender, nullifier, keccak256(bytes(level)), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        if (_recover(digest, signature) != attestor) revert BadSignature();

        claimedBy[nullifier] = msg.sender;
        records[msg.sender] = Record({nullifier: nullifier, level: level, at: uint64(block.timestamp)});
        unchecked {
            ++count;
        }

        emit Verified(msg.sender, nullifier, level, uint64(block.timestamp));
    }

    /// Keyed on the nullifier, not the timestamp: a record always has one, and it
    /// does not depend on the chain reporting a non-zero block time.
    function isVerified(address account) external view returns (bool) {
        return records[account].nullifier != bytes32(0);
    }

    function setAttestor(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        emit AttestorChanged(attestor, next);
        attestor = next;
    }

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        owner = next;
    }

    /// Strict ecrecover: rejects the malleable high-s half and any v outside {27,28},
    /// so one attestation cannot be reshaped into a second distinct-looking signature.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
