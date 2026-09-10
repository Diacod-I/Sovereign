// Drives /api/probe-endpoint against fixture endpoints covering every way a
// listing can be broken. Two Next instances: one permissive (fixtures live on
// localhost), one strict (to prove the SSRF guard actually refuses).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SELLER = '0x5E20F2ffE4f7C1a27412D53ab5C248bfef921A75';
const OTHER  = '0x1111111111111111111111111111111111111111';
const PERMISSIVE = 3010, STRICT = 3011;
// Run against a built app: `npm run build` first, then `node test/probe.e2e.mjs`.
const APP_DIR = process.env.PROBE_APP_DIR || new URL('..', import.meta.url).pathname;

let pass = 0, fail = 0;
const ok  = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const requiredHeader = (payTo, amount) => Buffer.from(JSON.stringify({
  x402Version: 2,
  resource: { url: '/task', description: 'fixture', mimeType: 'application/json' },
  accepts: [{ scheme: 'exact', network: 'eip155:5042002', asset: '0x3600000000000000000000000000000000000000',
              amount, payTo, maxTimeoutSeconds: 600, extra: { name: 'GatewayWalletBatched', version: '1' } }],
})).toString('base64');

// ---- fixtures -------------------------------------------------------------
const FIXTURES = {
  4001: (req, res) => { // healthy, Circle-style header
    res.writeHead(402, { 'PAYMENT-REQUIRED': requiredHeader(SELLER, '50000'), 'Content-Type': 'application/json' });
    res.end('{}');
  },
  4002: (req, res) => { // quotes someone else's payout address
    res.writeHead(402, { 'PAYMENT-REQUIRED': requiredHeader(OTHER, '50000'), 'Content-Type': 'application/json' });
    res.end('{}');
  },
  4003: (req, res) => { // charges more than the listing says
    res.writeHead(402, { 'PAYMENT-REQUIRED': requiredHeader(SELLER, '250000'), 'Content-Type': 'application/json' });
    res.end('{}');
  },
  4004: (req, res) => { // not gated at all
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: { free: true } }));
  },
  4005: (req, res) => { // 402 but nothing signable
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end('{}');
  },
  4006: (req, res) => { // non-Circle x402: accepts in the body
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepts: [{ scheme: 'exact', network: 'eip155:5042002', amount: '50000', payTo: SELLER }] }));
  },
  4007: (req, res) => { // redirect
    res.writeHead(302, { Location: 'https://example.com/elsewhere' });
    res.end();
  },
};
const servers = Object.entries(FIXTURES).map(([port, handler]) =>
  http.createServer(handler).listen(Number(port)));

// ---- next instances -------------------------------------------------------
const spawnNext = (port, allowPrivate) => spawn('npx', ['next', 'start', '-p', String(port)], {
  cwd: APP_DIR,
  env: { ...process.env, ALLOW_PRIVATE_PROBE: allowPrivate ? 'true' : 'false', NODE_ENV: 'production' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const nexts = [spawnNext(PERMISSIVE, true), spawnNext(STRICT, false)];
nexts.forEach(n => n.stderr.on('data', d => { const s = d.toString(); if (/Error|error/.test(s)) process.stderr.write('  [next] ' + s); }));

const waitUp = async (port) => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status < 500) return true; } catch {}
    await sleep(500);
  }
  return false;
};

const probe = async (port, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/probe-endpoint`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};
const check = (res, id) => res.checks?.find((c) => c.id === id);

try {
  if (!await waitUp(PERMISSIVE) || !await waitUp(STRICT)) throw new Error('next did not start');
  console.log('servers up\n');

  console.log('healthy endpoint');
  let r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4001/task', payTo: SELLER, price: '0.05' });
  r.ok ? ok('verifies') : bad('should verify: ' + JSON.stringify(r.checks?.filter(c=>c.status==='fail')));
  check(r,'paywalled')?.status === 'pass' ? ok('402 detected') : bad('402 not detected');
  check(r,'payTo')?.status === 'pass' ? ok('payTo matched') : bad('payTo not matched');
  check(r,'price')?.status === 'pass' ? ok('price matched') : bad('price not matched');
  r.quote?.amount === '50000' ? ok('quote surfaced') : bad('quote missing');

  console.log('\nwrong payout address');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4002/task', payTo: SELLER, price: '0.05' });
  !r.ok && check(r,'payTo')?.status === 'fail' ? ok('rejected — endpoint pays someone else') : bad('accepted a mismatched payee');

  console.log('\nprice mismatch');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4003/task', payTo: SELLER, price: '0.05' });
  !r.ok && check(r,'price')?.status === 'fail' ? ok('rejected — charges 0.25 not 0.05') : bad('accepted a mispriced listing');

  console.log('\nno paywall');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4004/task', payTo: SELLER, price: '0.05' });
  !r.ok && check(r,'paywalled')?.status === 'fail' ? ok('rejected — serves free') : bad('accepted an ungated endpoint');

  console.log('\n402 with no signable terms');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4005/task', payTo: SELLER, price: '0.05' });
  !r.ok && check(r,'quote')?.status === 'fail' ? ok('rejected — nothing to sign') : bad('accepted an unsignable 402');

  console.log('\nnon-Circle x402 (accepts in body)');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4006/task', payTo: SELLER, price: '0.05' });
  r.ok ? ok('verifies — body-style requirements parsed') : bad('failed body-style: ' + JSON.stringify(r.checks?.filter(c=>c.status==='fail')));

  console.log('\nredirect');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4007/task', payTo: SELLER, price: '0.05' });
  !r.ok ? ok('rejected — redirects') : bad('followed a redirect');

  console.log('\ndead endpoint');
  r = await probe(PERMISSIVE, { endpoint: 'http://127.0.0.1:4099/task', payTo: SELLER, price: '0.05' });
  !r.ok && check(r,'responds')?.status === 'fail' ? ok('rejected — nothing listening') : bad('accepted a dead endpoint');

  console.log('\ngarbage input (the bug that started this)');
  for (const junk of ['—', 'not a url', 'ftp://x.test/a']) {
    r = await probe(PERMISSIVE, { endpoint: junk, payTo: SELLER, price: '0.05' });
    !r.ok ? ok(`rejected ${JSON.stringify(junk)}`) : bad(`accepted ${JSON.stringify(junk)}`);
  }

  console.log('\nSSRF guard (strict instance)');
  for (const [url, label] of [
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['https://localhost:4001/task', 'localhost'],
    ['https://127.0.0.1:4001/task', 'loopback literal'],
    ['https://10.0.0.5/task', 'private range'],
    ['https://192.168.1.1/task', 'LAN'],
    ['http://example.com/task', 'plaintext http'],
  ]) {
    r = await probe(STRICT, { endpoint: url, payTo: SELLER, price: '0.05' });
    !r.ok ? ok(`refused ${label}`) : bad(`ALLOWED ${label} — SSRF hole`);
  }
} catch (e) {
  bad(e.message); console.error(e);
} finally {
  servers.forEach(s => s.close());
  nexts.forEach(n => n.kill('SIGKILL'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
