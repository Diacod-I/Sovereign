// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Sovereign Receipts
/// @notice Append-only record of what actually happened on a paid agent call.
///
/// A listing tells a buyer what an agent *claims*. A receipt tells them what it
/// *did*. Discovery without this is a directory, not a marketplace.
///
/// The buyer states an `expectation` before hiring, then files a receipt after
/// the call saying whether it was met. Grading against a commitment the buyer
/// wrote down first is far more legible than a star, and it is what makes
/// "did it meet expectations" answerable rather than vibes.
///
/// TRUST MODEL — read before quoting this as proof of anything:
/// this contract cannot verify that the payment it describes actually happened.
/// It records a claim, attributed to `msg.sender`. Two things keep that honest:
/// one receipt per (buyer, settlementRef) so a buyer cannot farm a worker's
/// score, and off-chain scoring that cross-checks `settlementRef` against real
/// USDC transfers on Arc and discounts buyers funded by the seller. Verifying
/// settlement on-chain would need the payment to route through a contract; that
/// is the rigorous upgrade, and it is deliberately not what this does.
contract Receipts {
    /// Buyer's assessment against their own stated expectation.
    uint8 public constant NOT_MET = 0;
    uint8 public constant PARTIALLY_MET = 1;
    uint8 public constant MET = 2;

    struct Receipt {
        string agentId;      // slug in AgentRegistry
        address buyer;
        bytes32 settlementRef; // tx hash / Gateway reference for the payment
        uint256 amount;      // USDC, 6 decimals, as actually paid
        uint32 latencyMs;    // wall-clock time the worker took
        bool delivered;      // did it return usable output at all
        uint8 met;           // NOT_MET | PARTIALLY_MET | MET
        string expectation;  // what the buyer said they wanted, before hiring
        string note;         // optional detail from the buyer
        uint64 at;
    }

    uint256 public count;
    mapping(uint256 => Receipt) public receipts;

    /// keccak(buyer, settlementRef) => filed. One receipt per payment.
    mapping(bytes32 => bool) public filed;

    // `agentId` is intentionally NOT indexed so the subgraph receives the
    // readable slug rather than a hash — same reason as AgentRegistry.
    event ReceiptFiled(
        uint256 indexed receiptId,
        string agentId,
        address indexed buyer,
        bytes32 settlementRef,
        uint256 amount,
        uint32 latencyMs,
        bool delivered,
        uint8 met,
        string expectation,
        string note,
        uint64 at
    );

    error AlreadyFiled();
    error BadRating();
    error NoAgent();

    /// @notice File the outcome of one paid call.
    /// @param settlementRef the payment this receipt describes; also the replay key
    function file(
        string calldata agentId,
        bytes32 settlementRef,
        uint256 amount,
        uint32 latencyMs,
        bool delivered,
        uint8 met,
        string calldata expectation,
        string calldata note
    ) external returns (uint256 id) {
        if (bytes(agentId).length == 0) revert NoAgent();
        if (met > MET) revert BadRating();

        bytes32 key = keccak256(abi.encodePacked(msg.sender, settlementRef));
        if (filed[key]) revert AlreadyFiled();
        filed[key] = true;

        id = ++count;
        receipts[id] = Receipt({
            agentId: agentId,
            buyer: msg.sender,
            settlementRef: settlementRef,
            amount: amount,
            latencyMs: latencyMs,
            delivered: delivered,
            met: met,
            expectation: expectation,
            note: note,
            at: uint64(block.timestamp)
        });

        emit ReceiptFiled(
            id, agentId, msg.sender, settlementRef, amount,
            latencyMs, delivered, met, expectation, note, uint64(block.timestamp)
        );
    }

    /// @notice Has this buyer already filed for this payment?
    function hasFiled(address buyer, bytes32 settlementRef) external view returns (bool) {
        return filed[keccak256(abi.encodePacked(buyer, settlementRef))];
    }
}
