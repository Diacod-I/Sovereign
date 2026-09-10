// End-to-end x402 test: buyer agent → seller worker, with Circle Gateway mocked.
//
// Proves the wiring that matters and that no key can prove on its own:
//   1. an unpaid POST /task is answered 402 with signable requirements
//   2. the buyer's Gateway client signs an authorization off those requirements
//   3. the worker verifies it, runs the work, settles, and returns 200 + output
//   4. verify and settle are each called exactly once, in that order
//
// Circle's hosted API is the ONLY thing stubbed — the worker middleware, the
// buyer client, the EIP-712 signing and the HTTP handshake are all real.
//
// Run: node test/e2e-x402.mjs

import express from 'express';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const MOCK_PORT = 8899;
const WORKER_PORT = 8898;
const RPC_PORT = 8897;
const ARC = 'eip155:5042002';
const SELLER = '0x5E20F2ffE4f7C1a27412D53ab5C248bfef921A75';
const PRICE = '0.05';

const calls = [];
const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1; };
const pass = (m) => console.log('✓ ' + m);

// ---------- mock Circle Gateway ----------
function startMockGateway() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/v1/x402/supported', (_req, res) => {
    calls.push('supported');
    res.json({
      kinds: [{
        x402Version: 1,
        scheme: 'exact',
        network: ARC,
        extra: {
          name: 'GatewayWalletBatched',
          version: '1',
          verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
          asset: '0x3600000000000000000000000000000000000000',
        },
      }],
      extensions: [],
      signers: {},
    });
  });

  const payerOf = (b) => {
    const p = b?.paymentPayload ?? b;
    return p?.payload?.authorization?.from ?? p?.payload?.from ?? null;
  };

  app.post('/v1/x402/verify', (req, res) => {
    calls.push('verify');
    res.json({ isValid: true, payer: payerOf(req.body) });
  });

  app.post('/v1/x402/settle', (req, res) => {
    calls.push('settle');
    res.json({
      success: true,
      payer: payerOf(req.body),
      transaction: '0x' + 'ab'.repeat(32),
      network: ARC,
    });
  });

  return new Promise((r) => { const s = app.listen(MOCK_PORT, () => r(s)); });
}

// ---------- mock Arc RPC (viem's publicClient probes chainId) ----------
function startMockRpc() {
  const app = express();
  app.use(express.json());
  app.post('/', (req, res) => {
    const reqs = Array.isArray(req.body) ? req.body : [req.body];
    const answer = (m) => {
      switch (m.method) {
        case 'eth_chainId': return '0x4cef52';
        case 'net_version': return '5042002';
        case 'eth_blockNumber': return '0x1';
        case 'eth_call': return '0x' + '0'.repeat(64);
        case 'eth_getBalance': return '0x0';
        default: return '0x';
      }
    };
    const out = reqs.map((m) => ({ jsonrpc: '2.0', id: m.id, result: answer(m) }));
    res.json(Array.isArray(req.body) ? out : out[0]);
  });
  return new Promise((r) => { const s = app.listen(RPC_PORT, () => r(s)); });
}

// ---------- the real worker, as a child process ----------
function startWorker() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(WORKER_PORT),
      WORKER_PAYTO: SELLER,
      PRICE,
      CIRCLE_FACILITATOR_URL: `http://127.0.0.1:${MOCK_PORT}`,
      CIRCLE_API_KEY: 'test-key',
      ALLOW_UNPAID: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [worker] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  [worker] ' + d));
  return child;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

// ---------- run ----------
const mock = await startMockGateway();
const rpc = await startMockRpc();
const worker = startWorker();

try {
  if (!(await waitFor(`http://127.0.0.1:${WORKER_PORT}/health`))) {
    throw new Error('worker did not come up');
  }
  pass('worker is listening');

  // 1) unpaid request must be answered 402 with signable requirements
  const unpaid = await fetch(`http://127.0.0.1:${WORKER_PORT}/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { address: '0xabc' } }),
  });
  const unpaidBody = await unpaid.json().catch(() => ({}));

  if (unpaid.status !== 402) fail(`unpaid request returned ${unpaid.status}, expected 402`);
  else pass('unpaid POST /task → 402');

  const accepts = unpaidBody.accepts ?? unpaidBody.paymentRequirements ?? [];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    fail('402 body carried no `accepts` requirements: ' + JSON.stringify(unpaidBody).slice(0, 300));
  } else {
    const req0 = accepts[0];
    pass(`402 quoted ${req0.amount} (atomic) to ${req0.payTo} on ${req0.network}`);
    if (String(req0.payTo).toLowerCase() !== SELLER.toLowerCase()) {
      fail(`402 payTo is ${req0.payTo}, expected the seller address ${SELLER}`);
    }
    if (String(req0.amount) !== '50000') {
      fail(`402 amount is ${req0.amount}, expected 50000 (0.05 USDC at 6dp)`);
    }
  }

  // 2+3) the buyer signs and pays for real
  const key = generatePrivateKey();
  const buyer = privateKeyToAccount(key).address;
  console.log(`  buyer agent wallet: ${buyer}`);

  const gateway = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: key,
    rpcUrl: `http://127.0.0.1:${RPC_PORT}`,
    headers: { Authorization: 'Bearer test-key' },
  });

  const result = await gateway.pay(`http://127.0.0.1:${WORKER_PORT}/task`, {
    method: 'POST',
    body: { input: { address: '0xabc' } },
  });

  if (result.status !== 200) fail(`paid request returned ${result.status}`);
  else pass(`paid POST /task → 200, ${result.formattedAmount} USDC`);

  const output = result.data?.output;
  if (!output?.ok) fail('worker output missing: ' + JSON.stringify(result.data).slice(0, 300));
  else pass(`worker served output (${output.summary})`);

  if (result.data?.payment?.payer?.toLowerCase() !== buyer.toLowerCase()) {
    fail(`worker reported payer ${result.data?.payment?.payer}, expected ${buyer}`);
  } else {
    pass('worker attributed the payment to the buyer agent wallet');
  }

  // 4) verify strictly before settle, once each
  const vi = calls.indexOf('verify');
  const si = calls.indexOf('settle');
  if (vi === -1) fail('facilitator verify was never called');
  else if (si === -1) fail('facilitator settle was never called');
  else if (vi > si) fail('settle ran before verify — x402 order violated');
  else pass('verify → serve → settle, in order');

  if (calls.filter((c) => c === 'settle').length !== 1) {
    fail(`settle called ${calls.filter((c) => c === 'settle').length} times, expected exactly 1`);
  } else pass('settled exactly once');

  console.log('\ncall sequence:', calls.join(' → '));
} catch (e) {
  fail(e.message);
  console.error(e);
} finally {
  worker.kill('SIGKILL');
  mock.close();
  rpc.close();
}

console.log(process.exitCode ? '\nFAILED' : '\nALL CHECKS PASSED');
process.exit(process.exitCode ?? 0);
