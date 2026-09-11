// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Verifications} from "../src/Verifications.sol";

/// The signature path is the part of this contract that cannot be checked by
/// reading it, so the tests are mostly about what a forged or reused attestation
/// does — not about the happy path.
contract VerificationsTest is Test {
    Verifications v;

    uint256 attestorPk = 0xA11CE;
    address attestor;
    address owner = address(0xB0B5);
    address alice = address(0xA1);
    address bob = address(0xB1);

    bytes32 constant NULL_A = keccak256("human-a");
    bytes32 constant NULL_B = keccak256("human-b");
    uint256 constant FUTURE = 4102444800; // 2100

    bytes32 constant TYPEHASH =
        keccak256("Attestation(address account,bytes32 nullifier,string level,uint256 deadline)");

    function setUp() public {
        attestor = vm.addr(attestorPk);
        vm.prank(owner);
        v = new Verifications(attestor);
        vm.warp(1_800_000_000);
    }

    function _sign(uint256 pk, address account, bytes32 nullifier, string memory level, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, account, nullifier, keccak256(bytes(level)), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", v.domainSeparator(), structHash));
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, sv);
    }

    function test_attest_records_the_human() public {
        vm.prank(alice);
        v.attest(NULL_A, "selfie", FUTURE, _sign(attestorPk, alice, NULL_A, "selfie", FUTURE));

        assertTrue(v.isVerified(alice));
        assertEq(v.claimedBy(NULL_A), alice);
        assertEq(v.count(), 1);
        (bytes32 nullifier, string memory level,) = v.records(alice);
        assertEq(nullifier, NULL_A);
        assertEq(level, "selfie");
    }

    /// The whole point: one human cannot spread across ten accounts and farm
    /// their own worker's reputation.
    function test_one_nullifier_one_account() public {
        vm.prank(alice);
        v.attest(NULL_A, "selfie", FUTURE, _sign(attestorPk, alice, NULL_A, "selfie", FUTURE));

        bytes memory sig = _sign(attestorPk, bob, NULL_A, "selfie", FUTURE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Verifications.NullifierTaken.selector, alice));
        v.attest(NULL_A, "selfie", FUTURE, sig);
    }

    function test_signature_is_bound_to_its_account() public {
        // Issued for alice, submitted by bob.
        bytes memory sig = _sign(attestorPk, alice, NULL_B, "selfie", FUTURE);
        vm.prank(bob);
        vm.expectRevert(Verifications.BadSignature.selector);
        v.attest(NULL_B, "selfie", FUTURE, sig);
    }

    function test_cannot_self_issue_a_badge() public {
        uint256 malloryPk = 0xBAD;
        bytes memory sig = _sign(malloryPk, alice, NULL_A, "selfie", FUTURE);
        vm.prank(alice);
        vm.expectRevert(Verifications.BadSignature.selector);
        v.attest(NULL_A, "selfie", FUTURE, sig);
    }

    function test_cannot_upgrade_the_level_after_signing() public {
        bytes memory sig = _sign(attestorPk, alice, NULL_A, "selfie", FUTURE);
        vm.prank(alice);
        vm.expectRevert(Verifications.BadSignature.selector);
        v.attest(NULL_A, "orb", FUTURE, sig);
    }

    function test_expired_attestation_is_refused() public {
        uint256 past = block.timestamp - 1;
        bytes memory sig = _sign(attestorPk, alice, NULL_A, "selfie", past);
        vm.prank(alice);
        vm.expectRevert(Verifications.Expired.selector);
        v.attest(NULL_A, "selfie", past, sig);
    }

    function test_cannot_attest_twice() public {
        vm.startPrank(alice);
        v.attest(NULL_A, "selfie", FUTURE, _sign(attestorPk, alice, NULL_A, "selfie", FUTURE));
        bytes memory sig = _sign(attestorPk, alice, NULL_B, "selfie", FUTURE);
        vm.expectRevert(Verifications.AlreadyVerified.selector);
        v.attest(NULL_B, "selfie", FUTURE, sig);
        vm.stopPrank();
    }

    function test_zero_nullifier_is_refused() public {
        bytes memory sig = _sign(attestorPk, alice, bytes32(0), "selfie", FUTURE);
        vm.prank(alice);
        vm.expectRevert(Verifications.ZeroNullifier.selector);
        v.attest(bytes32(0), "selfie", FUTURE, sig);
    }

    function test_malformed_signature_is_refused() public {
        vm.prank(alice);
        vm.expectRevert(Verifications.BadSignature.selector);
        v.attest(NULL_A, "selfie", FUTURE, hex"1234");
    }

    /// A signature reshaped into the high-s half must not pass as a second valid one.
    function test_high_s_signature_is_refused() public {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, alice, NULL_A, keccak256(bytes("selfie")), FUTURE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", v.domainSeparator(), structHash));
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(n - uint256(s));
        uint8 flippedV = sv == 27 ? 28 : 27;

        vm.prank(alice);
        vm.expectRevert(Verifications.BadSignature.selector);
        v.attest(NULL_A, "selfie", FUTURE, abi.encodePacked(r, flippedS, flippedV));
    }

    function test_only_owner_rotates_the_attestor() public {
        vm.prank(alice);
        vm.expectRevert(Verifications.NotOwner.selector);
        v.setAttestor(alice);

        vm.prank(owner);
        v.setAttestor(alice);
        assertEq(v.attestor(), alice);
    }

    /// Rotation must not invalidate anyone already verified.
    function test_rotation_does_not_disturb_existing_records() public {
        vm.prank(alice);
        v.attest(NULL_A, "selfie", FUTURE, _sign(attestorPk, alice, NULL_A, "selfie", FUTURE));

        vm.prank(owner);
        v.setAttestor(address(0xFEE));

        assertTrue(v.isVerified(alice));
    }
}
