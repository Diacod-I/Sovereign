// web/test/attestation.e2e.mjs
//
// Does the attestation the server signs actually satisfy Verifications.sol?
//
// Nothing in the app can answer that. The signature is produced by viem's
// signTypedData and checked by hand-rolled assembly in Solidity, and the two
// only agree if the domain fields, the type string, and the field order match
// exactly. Get any of it wrong and every verification fails on-chain with
// BadSignature, which says nothing about why.
//
// So this recomputes the digest the *contract* would build — from the literal
// type string in Verifications.sol, not from viem's encoder — and recovers the
// signer from it. If that comes back as the attestor address, the contract will
// accept it.
//
//   npm run test:attestation

import {
  encodeAbiParameters,
  keccak256,
  toHex,
  recoverAddress,
  concatHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ATTESTOR_PK = '0x' + '11'.repeat(32);
const CONTRACT = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = 5042002;
const USER = '0x2222222222222222222222222222222222222222';
const NULLIFIER = keccak256(toHex('a world id nullifier'));

process.env.ATTESTOR_PRIVATE_KEY = ATTESTOR_PK;
process.env.NEXT_PUBLIC_VERIFICATIONS_ADDRESS = CONTRACT;
process.env.NEXT_PUBLIC_ARC_CHAIN_ID = String(CHAIN_ID);

const { signAttestation, attestorAddress, attestorProblem } = await import('/tmp/attestation.mjs');

// --- these two strings are copied verbatim from Verifications.sol ------------
const ATTESTATION_TYPE = 'Attestation(address account,bytes32 nullifier,string level,uint256 deadline)';
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

const domainSeparator = keccak256(
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [
      keccak256(toHex(DOMAIN_TYPE)),
      keccak256(toHex('SovereignVerifications')),
      keccak256(toHex('1')),
      BigInt(CHAIN_ID),
      CONTRACT,
    ],
  ),
);

/** The digest as the contract builds it, byte for byte. */
function contractDigest({ account, nullifier, level, deadline }) {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [keccak256(toHex(ATTESTATION_TYPE)), account, nullifier, keccak256(toHex(level)), BigInt(deadline)],
    ),
  );
  return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

console.log('attestation signing\n');

check('the server reports itself configured', attestorProblem() === null);

const expectedSigner = privateKeyToAccount(ATTESTOR_PK).address;
check('attestorAddress() matches the key', attestorAddress()?.toLowerCase() === expectedSigner.toLowerCase());

const att = await signAttestation(USER, NULLIFIER, 'selfie');
check('an attestation is produced', !!att);
check('it names the account it was issued for', att?.account.toLowerCase() === USER.toLowerCase());
check('it carries the contract and chain the wallet must send to',
  att?.verifications.toLowerCase() === CONTRACT.toLowerCase() && att?.chainId === CHAIN_ID);
check('its deadline is in the future', Number(att?.deadline) > Math.floor(Date.now() / 1000));

const recovered = await recoverAddress({ hash: contractDigest(att), signature: att.signature });
check('the contract would recover the attestor from this signature',
  recovered.toLowerCase() === expectedSigner.toLowerCase());

// Each signed field must actually be covered by the signature. If any of these
// recovered the attestor anyway, that field could be swapped after signing.
for (const [name, tampered] of [
  ['account', { ...att, account: '0x3333333333333333333333333333333333333333' }],
  ['nullifier', { ...att, nullifier: keccak256(toHex('a different human')) }],
  ['level', { ...att, level: 'orb' }],
  ['deadline', { ...att, deadline: String(Number(att.deadline) + 1) }],
]) {
  const r = await recoverAddress({ hash: contractDigest(tampered), signature: att.signature });
  check(`tampering with ${name} breaks the signature`, r.toLowerCase() !== expectedSigner.toLowerCase());
}

// World returns a 32-byte nullifier. Anything else must be refused rather than
// zero-padded, which would attest a different human than the one verified.
check('a short nullifier is refused', (await signAttestation(USER, '0xdeadbeef', 'selfie')) === null);
check('a malformed account is refused', (await signAttestation('nope', NULLIFIER, 'selfie')) === null);

// Without a key the flow must degrade to local-only, not throw.
process.env.ATTESTOR_PRIVATE_KEY = '';
const { signAttestation: unconfigured, attestorProblem: problem } =
  await import('/tmp/attestation.mjs?unconfigured');
check('an unset key is reported rather than thrown', typeof problem() === 'string');
check('an unset key yields no attestation instead of an error',
  (await unconfigured(USER, NULLIFIER, 'selfie')) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
