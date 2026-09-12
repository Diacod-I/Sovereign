#!/usr/bin/env node
// Points the Verifications datasource at a freshly deployed contract.
//
//   node set-verifications.mjs 0xAddress 61234567
//
// A two-field hand edit, except that getting either one wrong fails quietly:
// a bad address indexes nothing and looks like "no one has verified yet", and a
// startBlock that is too late silently skips every verification before it. Both
// read as an empty marketplace rather than as a mistake, so this validates and
// then tells you what it wrote.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'subgraph.yaml');

const [address, block] = process.argv.slice(2);

if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) {
  console.error('\n  Usage: node set-verifications.mjs <0xContractAddress> <deployBlock>\n');
  process.exit(1);
}
if (!/^\d+$/.test(block || '') || Number(block) <= 0) {
  console.error('\n  The deploy block must be a positive number.');
  console.error('  forge prints it, or read it from broadcast/DeployVerifications.s.sol/5042002/run-latest.json\n');
  process.exit(1);
}

// Is there actually a contract there?
//
// `forge script` simulates before it broadcasts and logs the address the deploy
// WOULD get. If the broadcast then fails -- out of gas money is the usual way --
// that address is printed, looks authoritative, and does not exist. Pointing the
// subgraph at it indexes nothing forever and presents as "nobody has verified
// yet" rather than as a mistake, which is the most expensive kind of quiet.
//
// Skippable with --no-check for an address that is deployed but not yet visible
// to whichever RPC this machine can reach.
const RPC = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.io';

if (!process.argv.includes('--no-check')) {
  let code = null;
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (!json.error) code = json.result;
  } catch {
    code = null;
  }

  if (code === '0x' || code === '0x0') {
    console.error('');
    console.error(`  Nothing is deployed at ${address} on ${RPC}.`);
    console.error('');
    console.error('  If forge printed this address and then failed to broadcast, that was the');
    console.error('  SIMULATED address and the deploy never landed. Fund the deployer and run');
    console.error('  the script again; the address will differ.');
    console.error('');
    console.error('  Override with --no-check only if you are sure it is deployed.');
    console.error('');
    process.exit(1);
  }
  if (code === null) {
    console.error(`\n  Could not reach ${RPC} to confirm the contract exists. Continuing anyway.\n`);
  } else {
    console.log(`\n  Confirmed: ${(code.length - 2) / 2} bytes of code at ${address}`);
  }
}

const src = fs.readFileSync(FILE, 'utf8');

// Anchored to the Verifications block specifically. A blind global replace
// would repoint AgentRegistry and Receipts as well, which is a far worse
// afternoon than a failed script.
const start = src.indexOf('name: Verifications');
if (start < 0) {
  console.error('\n  No Verifications datasource in subgraph.yaml.\n');
  process.exit(1);
}
const end = src.indexOf('\n  - kind:', start);
const section = src.slice(start, end < 0 ? undefined : end);

const patched = section
  .replace(/address:\s*"0x[a-fA-F0-9]{40}"[^\n]*/, `address: "${address}"`)
  .replace(/startBlock:\s*\d+[^\n]*/, `startBlock: ${block}`);

if (patched === section) {
  console.error('\n  Nothing changed. Are address and startBlock already set?\n');
  process.exit(1);
}

fs.writeFileSync(FILE, src.slice(0, start) + patched + (end < 0 ? '' : src.slice(end)));

console.log('');
console.log(`  Verifications -> ${address}`);
console.log(`  startBlock    -> ${block}`);
console.log('');
console.log('  Next:  npm run codegen && npm run build && npm run deploy');
console.log('');
