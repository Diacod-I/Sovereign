// web/test/hosted-worker.e2e.mjs
//
// The non-developer path, end to end.
//
// A seller with no code and no server pastes a webhook URL; Sovereign puts the
// x402 wall in front of it. Everything here is real except Circle's hosted API
// and the seller's own tool: the Next route, the Gateway middleware, the buyer's
// EIP-712 signing, the wallet-signature auth, the secret sealing.
//
// What it proves, in order:
//   1. a worker cannot be created without a signature from the wallet it names
//   2. an unpaid call to the hosted URL is answered 402 with signable terms
//   3. a paid call reaches the seller's upstream, with their secret attached
//   4. verify runs before settle, once each
//   5. an upstream that fails is NOT charged for — settlement is aborted, and
//      the buyer is told so as data rather than as a thrown status code
//   6. a retired worker refuses BEFORE taking payment
//
// Needs a production build first:
//   npm run build && npm run test:hosted

import express from 'express';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const MOCK_PORT = 8899;
const UPSTREAM_PORT = 8896;
const RPC_PORT = 8897;
const APP_PORT = 3999;
const ARC = 'eip155:5042002';
const PRICE = '0.05';
const UPSTREAM_SECRET = 'sk-seller-tool-secret';

// Unique per run. Slugs are claimed permanently on purpose — a retired worker
// must not have its name taken over by someone else, since buyers may hold a
// listing pointing at it — so reusing fixed names across runs would make every
// run after the first fail on state it did not create.
const RUN = Math.random().toString(36).slice(2, 6);
const OK_SLUG = `risk-check-${RUN}`;
const BROKEN_SLUG = `broken-worker-${RUN}`;

const calls = [];
const upstreamSaw = [];
let pass_ = 0, fail_ = 0;
const fail = (m) => { fail_++; console.error('  ✗ ' + m); process.exitCode = 1; };
const pass = (m) => { pass_++; console.log('  ✓ ' + m); };

// ---------- mock Circle Gateway ----------
function startMockGateway() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.get('/v1/x402/supported', (_req, res) => {
    calls.push('supported');
    res.json({
      kinds: [{
        x402Version: 1, scheme: 'exact', network: ARC,
        extra: {
          name: 'GatewayWalletBatched', version: '1',
          verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
          assets: [{ symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 }],
        },
      }],
      extensions: [], signers: {},
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
    res.json({ success: true, payer: payerOf(req.body), transaction: '0x' + 'ab'.repeat(32), network: ARC });
  });
  return new Promise((r) => { const s = app.listen(MOCK_PORT, () => r(s)); });
}

function startMockRpc() {
  const app = express();
  app.use(express.json());
  app.post('/', (req, res) => {
    const reqs = Array.isArray(req.body) ? req.body : [req.body];
    const answer = (m) => ({
      eth_chainId: '0x4cef52', net_version: '5042002', eth_blockNumber: '0x1',
      eth_call: '0x' + '0'.repeat(64), eth_getBalance: '0x0',
    }[m.method] ?? '0x');
    const out = reqs.map((m) => ({ jsonrpc: '2.0', id: m.id, result: answer(m) }));
    res.json(Array.isArray(req.body) ? out : out[0]);
  });
  return new Promise((r) => { const s = app.listen(RPC_PORT, () => r(s)); });
}

/** The seller's existing no-code tool. /ok answers; /broken 500s. */
function startMockUpstream() {
  const app = express();
  app.use(express.json());
  app.post('/ok', (req, res) => {
    upstreamSaw.push({ path: '/ok', auth: req.headers['x-api-key'], body: req.body });
    res.json({ verdict: 'clean', checked: ['ofac', 'chainalysis'], input: req.body?.input ?? null });
  });
  app.post('/broken', (req, res) => {
    upstreamSaw.push({ path: '/broken' });
    res.status(500).json({ error: 'the seller tool fell over' });
  });
  return new Promise((r) => { const s = app.listen(UPSTREAM_PORT, () => r(s)); });
}

function startApp() {
  // detached so the whole process group can be killed. `npx next start` spawns a
  // grandchild; killing the npx wrapper alone leaves the server holding the port,
  // and the next run then quietly reuses a server with the previous run's state.
  const child = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    detached: true,
    env: {
      ...process.env,
      CIRCLE_FACILITATOR_URL: `http://127.0.0.1:${MOCK_PORT}`,
      CIRCLE_API_KEY: 'test-key',
      WORKER_SECRET_KEY: '0x' + '7'.repeat(64),
      // The mock upstream is on localhost, which the SSRF guard exists to refuse.
      // Turning it off here is the same escape hatch the probe already has, and
      // the guard itself is covered by its own test.
      ALLOW_PRIVATE_PROBE: 'true',
      NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${APP_PORT}`,
      NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID || 'clzzz000000000000000000zz',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [app] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  [app] ' + d));
  return child;
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await sleep(400);
  }
  return false;
}

const authMessage = ({ action, slug, owner, upstreamUrl, issuedAt }) =>
  [`Sovereign: ${action} hosted worker`, `slug: ${slug}`, `owner: ${owner.toLowerCase()}`,
   `upstream: ${upstreamUrl}`, `issued: ${issuedAt}`].join('\n');

const base = `http://127.0.0.1:${APP_PORT}`;

async function saveWorker(account, fields, { breakSignature = false } = {}) {
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({
    message: authMessage({
      action: 'save', slug: fields.slug, owner: account.address,
      upstreamUrl: breakSignature ? 'https://somewhere.else/' : fields.upstreamUrl, issuedAt,
    }),
  });
  const res = await fetch(`${base}/api/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save', owner: account.address, issuedAt, signature, ...fields }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------- run ----------
const mock = await startMockGateway();
const rpc = await startMockRpc();
const upstream = await startMockUpstream();
const app = startApp();

try {
  if (!(await waitFor(`${base}/w/nope`))) throw new Error('app did not come up');
  pass('app is listening');

  const sellerKey = generatePrivateKey();
  const seller = privateKeyToAccount(sellerKey);

  console.log('\n-- creating a hosted worker needs the seller’s signature');

  const unsigned = await fetch(`${base}/api/workers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'save', slug: `unsigned-${RUN}`, owner: seller.address,
      upstreamUrl: `http://127.0.0.1:${UPSTREAM_PORT}/ok`, price: PRICE, payTo: seller.address,
    }),
  });
  if (unsigned.status === 401) pass('an unsigned save is refused');
  else fail(`unsigned save returned ${unsigned.status}, expected 401`);

  const tampered = await saveWorker(seller, {
    slug: `tampered-${RUN}`, upstreamUrl: `http://127.0.0.1:${UPSTREAM_PORT}/ok`,
    price: PRICE, payTo: seller.address,
  }, { breakSignature: true });
  if (tampered.status === 401) pass('a signature covering a different upstream is refused');
  else fail(`tampered save returned ${tampered.status}, expected 401`);

  const created = await saveWorker(seller, {
    slug: OK_SLUG, upstreamUrl: `http://127.0.0.1:${UPSTREAM_PORT}/ok`,
    price: PRICE, payTo: seller.address,
    authHeaderName: 'X-Api-Key', authSecret: UPSTREAM_SECRET,
  });
  if (created.status === 200 && created.body.ok) pass(`worker created at ${created.body.worker.url}`);
  else fail(`create failed: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);

  if (JSON.stringify(created.body).includes(UPSTREAM_SECRET)) {
    fail('the upstream secret came back in the API response');
  } else pass('the upstream secret never leaves the server');

  console.log('\n-- an unpaid call is answered 402 with terms a buyer can sign');

  const unpaid = await fetch(`${base}/w/${OK_SLUG}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { address: '0xabc' } }),
  });
  if (unpaid.status !== 402) {
    fail(`unpaid call returned ${unpaid.status}: ${(await unpaid.text()).slice(0, 200)}`);
  } else {
    pass('unpaid POST /w/<slug> → 402');
    let quoted = {};
    try { quoted = JSON.parse(Buffer.from(unpaid.headers.get('payment-required') ?? '', 'base64').toString('utf8')); } catch {}
    const req0 = (quoted.accepts ?? [])[0];
    if (!req0) fail('402 carried no signable requirements');
    else {
      if (String(req0.payTo).toLowerCase() === seller.address.toLowerCase()) pass('402 quotes the seller’s payout address');
      else fail(`402 payTo is ${req0.payTo}, expected ${seller.address}`);
      if (String(req0.amount) === '50000') pass('402 quotes 0.05 USDC as 50000 atomic units');
      else fail(`402 amount is ${req0.amount}, expected 50000`);
    }
  }

  if (upstreamSaw.length === 0) pass('the upstream was not called for an unpaid request');
  else fail('the upstream was called before payment');

  console.log('\n-- a paid call reaches the seller’s tool and comes back');

  const buyerKey = generatePrivateKey();
  const buyer = privateKeyToAccount(buyerKey).address;
  const gateway = new GatewayClient({
    chain: 'arcTestnet', privateKey: buyerKey,
    rpcUrl: `http://127.0.0.1:${RPC_PORT}`, headers: { Authorization: 'Bearer test-key' },
  });

  const paid = await gateway.pay(`${base}/w/${OK_SLUG}`, {
    method: 'POST', body: { input: { address: '0xabc' } },
  });

  if (paid.status === 200) pass(`paid POST /w/<slug> → 200, ${paid.formattedAmount} USDC`);
  else fail(`paid call returned ${paid.status}: ${JSON.stringify(paid.data).slice(0, 200)}`);

  if (paid.data?.verdict === 'clean') pass('the seller’s own payload came back untouched');
  else fail('upstream payload missing: ' + JSON.stringify(paid.data).slice(0, 200));

  const seen = upstreamSaw.find((u) => u.path === '/ok');
  if (seen?.auth === UPSTREAM_SECRET) pass('the seller’s secret was attached to the upstream call');
  else fail(`upstream saw auth header “${seen?.auth}”, expected the stored secret`);

  if (seen?.body?.input?.address === '0xabc') pass('the buyer’s input reached the upstream');
  else fail('buyer input did not reach the upstream: ' + JSON.stringify(seen?.body));

  const vi = calls.indexOf('verify'), si = calls.indexOf('settle');
  if (vi === -1) fail('facilitator verify was never called');
  else if (si === -1) fail('facilitator settle was never called');
  else if (vi > si) fail('settle ran before verify — x402 order violated');
  else pass('verify → serve → settle, in order');
  if (calls.filter((c) => c === 'settle').length === 1) pass('settled exactly once');
  else fail(`settle called ${calls.filter((c) => c === 'settle').length} times`);

  console.log('\n-- an upstream that fails is never charged for');

  await saveWorker(seller, {
    slug: BROKEN_SLUG, upstreamUrl: `http://127.0.0.1:${UPSTREAM_PORT}/broken`,
    price: PRICE, payTo: seller.address,
  });

  // The whole point of doing the work inside onBeforeSettle: a worker that
  // fails must cost the buyer nothing. Settlement should never be reached.
  const settlesBeforeBroken = calls.filter((c) => c === 'settle').length;

  let brokenPaid, threw = null;
  try {
    brokenPaid = await gateway.pay(`${base}/w/${BROKEN_SLUG}`, { method: 'POST', body: { input: {} } });
  } catch (e) { threw = e; }

  if (threw) {
    fail(`the buyer's client threw instead of receiving the failure: ${threw.message}`);
  } else {
    const env = brokenPaid?.data?.sovereign;
    const raw = JSON.stringify(brokenPaid?.data ?? {});
    if (env?.delivered === false) pass('the buyer receives an explicit delivered:false');
    else fail(`no delivered:false in the response: ${raw.slice(0, 250)}`);
    if (env?.paid === false) pass('the response states the buyer was NOT charged');
    else fail(`paid was ${env?.paid}, expected false: ${raw.slice(0, 250)}`);
    if (env?.upstreamStatus === 500) pass('the upstream status is reported');
    else fail(`upstreamStatus was ${env?.upstreamStatus}, expected 500`);
    if (typeof env?.reason === 'string' && env.reason.length > 0) pass('a reason is given');
    else fail('no reason given');
  }

  if (calls.filter((c) => c === 'settle').length === settlesBeforeBroken) {
    pass('settlement was never attempted for a failing worker');
  } else {
    fail('the failing worker was settled — the buyer was charged for nothing');
  }

  // Verification must still have happened: the payment was good, the work was not.
  if (calls.filter((c) => c === 'verify').length > 1) pass('the payment was still verified before the work ran');
  else fail('verify was not called for the failing worker');

  console.log('\n-- a delivered payload is never confused with a failure');
  if (paid.data?.sovereign === undefined) pass('a delivered response carries no sovereign envelope');
  else fail('a delivered response carried a sovereign envelope');

  console.log('\n-- a retired worker refuses before taking money');

  const issuedAt = new Date().toISOString();
  const delSig = await seller.signMessage({
    message: authMessage({ action: 'delete', slug: OK_SLUG, owner: seller.address, upstreamUrl: '', issuedAt }),
  });
  const del = await fetch(`${base}/api/workers`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: OK_SLUG, owner: seller.address, issuedAt, signature: delSig }),
  });
  if (del.ok) pass('the owner can retire a worker');
  else fail(`retire returned ${del.status}`);

  const settlesBefore = calls.filter((c) => c === 'settle').length;
  const retired = await fetch(`${base}/w/${OK_SLUG}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (retired.status === 410) pass('a retired worker answers 410');
  else fail(`retired worker returned ${retired.status}, expected 410`);
  if (calls.filter((c) => c === 'settle').length === settlesBefore) {
    pass('no settlement was attempted for a retired worker');
  } else fail('a retired worker still took payment');

  console.log('\n-- an unknown slug is a 404, not a payment prompt');
  const unknown = await fetch(`${base}/w/does-not-exist-zzzz`, { method: 'POST', body: '{}' });
  if (unknown.status === 404) pass('unknown slug → 404');
  else fail(`unknown slug returned ${unknown.status}`);

} catch (e) {
  fail('threw: ' + (e?.stack ?? e));
} finally {
  try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill('SIGTERM'); }
  mock.close(); rpc.close(); upstream.close();
  await sleep(300);
}

console.log(`\n${pass_} passed, ${fail_} failed`);
process.exit(fail_ ? 1 : 0);
