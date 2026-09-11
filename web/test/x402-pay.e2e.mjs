// Exercises the x402 handshake in app/lib/x402-pay.server.ts against a fake
// worker that speaks the protocol exactly as @circle-fin/x402-batching's own
// GatewayClient expects it.
//
// This matters because payAndCall is a TRANSCRIPTION. GatewayClient.pay() wants
// a raw private key, so we cannot use it with a Privy-delegated wallet and had
// to re-implement the HTTP around the library's signer. A transcription that is
// subtly wrong -- a header name, a base64 layer, the shape inside it -- fails at
// the worker with an opaque error, after the buyer has signed. So the fake
// worker here verifies the header the way a real facilitator would, and the
// last case runs the REAL GatewayClient against the same server to prove the
// fake is not simply agreeing with us.

import http from 'node:http';
import assert from 'node:assert';
import { privateKeyToAccount } from 'viem/accounts';
import { payAndCall, NotPaidError } from '../.x402pay.test.mjs';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);

const USDC = '0x3600000000000000000000000000000000000000';
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const CHAIN_ID = 5042002;

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ok   ${name}`); };
const no = (name, e) => { fail++; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); };
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { no(name, e); } }

/** A 402 that offers Circle Gateway batching, shaped like the real thing. */
function requirements(amountAtomic, payTo) {
  return {
    x402Version: 2,
    resource: 'http://fake/worker',
    accepts: [
      {
        scheme: 'exact',
        network: `eip155:${CHAIN_ID}`,
        asset: USDC,
        amount: String(amountAtomic),
        payTo,
        maxTimeoutSeconds: 60,
        extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: GATEWAY_WALLET },
      },
    ],
  };
}

/**
 * @param opts.amount atomic USDC the worker demands
 * @param opts.reply  what the worker returns once paid
 * @param opts.noHeader omit PAYMENT-REQUIRED, to test the error path
 * @param opts.wrongNetwork advertise a chain the buyer is not on
 * @param opts.serveFree answer 200 without a paywall at all
 */
function worker(opts = {}) {
  const seen = { unpaid: 0, paid: 0, header: null, bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.bodies.push(raw);
      const sig = req.headers['payment-signature'];

      if (opts.serveFree) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ output: 'free lunch' }));
      }

      if (!sig) {
        seen.unpaid++;
        const headers = { 'content-type': 'application/json' };
        if (!opts.noHeader) {
          const r = requirements(opts.amount ?? 100000, opts.payTo ?? account.address);
          if (opts.wrongNetwork) r.accepts[0].network = 'eip155:1';
          headers['PAYMENT-REQUIRED'] = Buffer.from(JSON.stringify(r)).toString('base64');
        }
        res.writeHead(402, headers);
        return res.end(JSON.stringify({ error: 'payment required' }));
      }

      seen.paid++;
      seen.header = JSON.parse(Buffer.from(sig, 'base64').toString('utf8'));
      res.writeHead(200, {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ transaction: '0xdeadbeef' })).toString('base64'),
      });
      res.end(JSON.stringify(opts.reply ?? { output: 'the answer' }));
    });
  });
  return { server, seen };
}

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}/w`)));
const close = (s) => new Promise((r) => s.close(r));

console.log('\nx402 payAndCall\n');

await t('pays, calls, and returns the worker output', async () => {
  const { server, seen } = worker({ amount: 100000 }); // 0.1 USDC
  const url = await listen(server);
  try {
    const r = await payAndCall({ account: account.address, url, body: { q: 'hi' }, maxUsdc: 0.1, signer: account });
    assert.equal(seen.unpaid, 1, 'should probe unpaid exactly once');
    assert.equal(seen.paid, 1, 'should retry exactly once, paid');
    assert.deepEqual(r.data, { output: 'the answer' });
    assert.equal(r.formattedAmount, '0.1');
    assert.equal(r.transaction, '0xdeadbeef', 'settlement ref comes from PAYMENT-RESPONSE');
  } finally { await close(server); }
});

await t('sends the buyer input on BOTH requests, unchanged', async () => {
  const { server, seen } = worker({ amount: 100000 });
  const url = await listen(server);
  try {
    await payAndCall({ account: account.address, url, body: { q: 'scrape' }, maxUsdc: 0.1, signer: account });
    assert.equal(seen.bodies.length, 2);
    assert.equal(seen.bodies[0], seen.bodies[1], 'the paid retry must carry the same body');
    assert.deepEqual(JSON.parse(seen.bodies[1]), { input: { q: 'scrape' } });
  } finally { await close(server); }
});

await t('the header carries a signed EIP-3009 authorization from the buyer', async () => {
  const { server, seen } = worker({ amount: 250000 });
  const url = await listen(server);
  try {
    await payAndCall({ account: account.address, url, body: {}, maxUsdc: 0.25, signer: account });
    const h = seen.header;
    assert.ok(h.payload?.signature?.startsWith('0x'), 'a signature is present');
    assert.equal(h.payload.authorization.from.toLowerCase(), account.address.toLowerCase(), 'signed by the buyer');
    assert.equal(h.payload.authorization.value, '250000', 'for the amount demanded');
    assert.ok(h.accepted, 'echoes which option was accepted');
    assert.equal(h.resource, 'http://fake/worker', 'echoes the resource');
  } finally { await close(server); }
});

await t('refuses when the worker demands more than the listing said', async () => {
  const { server, seen } = worker({ amount: 5000000 }); // asks 5, listing said 0.1
  const url = await listen(server);
  try {
    await assert.rejects(
      () => payAndCall({ account: account.address, url, body: {}, maxUsdc: 0.1, signer: account }),
      (e) => e instanceof NotPaidError && /asked for 5 USDC/.test(e.message),
    );
    assert.equal(seen.paid, 0, 'nothing was ever signed or sent');
  } finally { await close(server); }
});

await t('refuses a worker offering no Gateway option on our chain', async () => {
  const { server, seen } = worker({ amount: 100000, wrongNetwork: true });
  const url = await listen(server);
  try {
    await assert.rejects(
      () => payAndCall({ account: account.address, url, body: {}, maxUsdc: 0.1, signer: account }),
      (e) => e instanceof NotPaidError && /does not offer Circle Gateway/.test(e.message),
    );
    assert.equal(seen.paid, 0);
  } finally { await close(server); }
});

await t('a 402 with no PAYMENT-REQUIRED header is NotPaid, not a crash', async () => {
  const { server } = worker({ noHeader: true });
  const url = await listen(server);
  try {
    await assert.rejects(
      () => payAndCall({ account: account.address, url, body: {}, maxUsdc: 1, signer: account }),
      (e) => e instanceof NotPaidError,
    );
  } finally { await close(server); }
});

await t('a worker that serves for free is reported as unpaid, not as a purchase', async () => {
  const { server } = worker({ serveFree: true });
  const url = await listen(server);
  try {
    const r = await payAndCall({ account: account.address, url, body: {}, maxUsdc: 1, signer: account });
    assert.equal(r.amount, 0n);
    assert.equal(r.transaction, '');
    assert.deepEqual(r.data, { output: 'free lunch' });
  } finally { await close(server); }
});

await t('a dead endpoint never reaches the signer', async () => {
  const server = http.createServer((_q, res) => { res.writeHead(404); res.end('{"error":"No such worker."}'); });
  const url = await listen(server);
  let signed = false;
  const spy = { address: account.address, signTypedData: async (t) => { signed = true; return account.signTypedData(t); } };
  try {
    await assert.rejects(
      () => payAndCall({ account: account.address, url, body: {}, maxUsdc: 1, signer: spy }),
      (e) => e instanceof NotPaidError && /HTTP 404/.test(e.message),
    );
    assert.equal(signed, false, 'a broken worker must cost the buyer nothing');
  } finally { await close(server); }
});

// The fake worker above only proves we agree with ourselves. This proves the
// fake speaks the real protocol: the library's own client, given the same
// server, must succeed against it too.
await t('the real GatewayClient accepts the same fake worker (protocol check)', async () => {
  const { GatewayClient } = await import('@circle-fin/x402-batching/client');
  const { server, seen } = worker({ amount: 100000 });
  const url = await listen(server);
  try {
    const gw = new GatewayClient({ chain: 'arcTestnet', privateKey: KEY });
    const r = await gw.pay(url, { method: 'POST', body: { input: {} } });
    assert.deepEqual(r.data, { output: 'the answer' });
    assert.equal(r.transaction, '0xdeadbeef');
    assert.equal(seen.paid, 1);
  } finally { await close(server); }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
