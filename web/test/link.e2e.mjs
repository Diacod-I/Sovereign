// web/test/link.e2e.mjs
//
// Pairing a terminal with an account, and what a linked terminal may then spend.
//
// This is the most dangerous surface in the product: a token minted here can
// move somebody's money. So most of these assertions are about what must NOT
// work — collecting with the wrong secret, approving a wider scope than was
// asked for, paying a stranger, paying above the limits, paying at all with a
// discovery-only link.
//
//   npm run build && npm run test:link

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const PORT = 3997;
const base = `http://127.0.0.1:${PORT}`;

let pass_ = 0, fail_ = 0;
const pass = (m) => { pass_++; console.log('  ✓ ' + m); };
const fail = (m) => { fail_++; console.error('  ✗ ' + m); process.exitCode = 1; };

function startApp() {
  const child = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    detached: true,
    env: {
      ...process.env,
      // One process for one run, so the in-memory store is genuinely fine here.
      SOVEREIGN_ALLOW_EPHEMERAL_LINKS: 'true',
      NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID || 'clzzz000000000000000000zz',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [app] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  [app] ' + d));
  return child;
}

const api = async (path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const linkMsg = ({ code, account, scope, issuedAt }) =>
  ['Sovereign: link a terminal', `code: ${code}`, `account: ${account.toLowerCase()}`,
   `grants: ${scope === 'spend' ? 'discovery and spending under your limits' : 'discovery only'}`,
   `issued: ${issuedAt}`].join('\n');

const policyMsg = (op, account, issuedAt) =>
  [`Sovereign: ${op} spend policy`, `account: ${account.toLowerCase()}`, `issued: ${issuedAt}`].join('\n');

async function pair(acct, scope, { wrongVerifier = false } = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  const started = await api('/api/link', { op: 'start', challenge, scope, label: 'test' });
  const code = started.body.code;
  const issuedAt = new Date().toISOString();
  const signature = await acct.signMessage({ message: linkMsg({ code, account: acct.address, scope, issuedAt }) });
  await api('/api/link', { op: 'approve', code, account: acct.address, scope, issuedAt, signature });
  const got = await api('/api/link', {
    op: 'collect', code,
    verifier: wrongVerifier ? crypto.randomBytes(32).toString('base64url') : verifier,
  });
  return { code, verifier, ...got.body };
}

const app = startApp();

try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/link'); if (r.status < 500) break; } catch {}
    await sleep(400);
  }
  pass('app is listening');

  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());

  console.log('\n-- the terminal that started the pairing is the only one that can finish it');

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  const started = await api('/api/link', { op: 'start', challenge, scope: 'spend', label: 'my-project' });
  const code = started.body.code;
  if (/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code || '')) pass(`a code was issued (${code})`);
  else fail(`bad code: ${code} ${JSON.stringify(started.body)}`);

  const seen = await api('/api/link', { op: 'status', code });
  if (seen.body.state === 'pending' && seen.body.scope === 'spend') pass('the approval page can read what it is approving');
  else fail(`status was ${JSON.stringify(seen.body)}`);

  const early = await api('/api/link', { op: 'collect', code, verifier });
  if (early.body.state === 'pending') pass('collecting before approval returns nothing');
  else fail(`early collect gave ${JSON.stringify(early.body)}`);

  console.log('\n-- approval is signed, and scoped to what the terminal asked for');

  const issuedAt = new Date().toISOString();
  const goodSig = await owner.signMessage({ message: linkMsg({ code, account: owner.address, scope: 'spend', issuedAt }) });

  const wrongScope = await api('/api/link', {
    op: 'approve', code, account: owner.address, scope: 'identity', issuedAt,
    signature: await owner.signMessage({ message: linkMsg({ code, account: owner.address, scope: 'identity', issuedAt }) }),
  });
  if (wrongScope.status === 400) pass('approving a different scope than was asked for is refused');
  else fail(`scope mismatch returned ${wrongScope.status}`);

  const badSig = await api('/api/link', {
    op: 'approve', code, account: owner.address, scope: 'spend', issuedAt,
    signature: await stranger.signMessage({ message: linkMsg({ code, account: owner.address, scope: 'spend', issuedAt }) }),
  });
  if (badSig.status === 401) pass('someone else signing for your account is refused');
  else fail(`bad signature returned ${badSig.status}`);

  const ok = await api('/api/link', { op: 'approve', code, account: owner.address, scope: 'spend', issuedAt, signature: goodSig });
  if (ok.status === 200) pass('the account holder can approve');
  else fail(`approve returned ${ok.status}: ${JSON.stringify(ok.body)}`);

  console.log('\n-- knowing the code is never enough to take the token');

  const thief = await api('/api/link', { op: 'collect', code, verifier: crypto.randomBytes(32).toString('base64url') });
  if (thief.body.state === 'pending' && !thief.body.token) pass('collecting with the wrong secret yields nothing');
  else fail(`wrong-verifier collect gave ${JSON.stringify(thief.body)}`);

  const mine = await api('/api/link', { op: 'collect', code, verifier });
  if (mine.body.state === 'approved' && mine.body.token) pass('the real terminal collects its token');
  else fail(`collect gave ${JSON.stringify(mine.body)}`);
  if (mine.body.account?.toLowerCase() === owner.address.toLowerCase()) pass('the token names the approving account');
  else fail(`token account was ${mine.body.account}`);

  const replay = await api('/api/link', { op: 'collect', code, verifier });
  if (replay.body.state === 'expired') pass('a code is spent once the token is handed over');
  else fail(`replayed collect gave ${JSON.stringify(replay.body)}`);

  const spendToken = mine.body.token;

  console.log('\n-- what a linked terminal may spend');

  const pay = (token, body) => api('/api/agent/pay', body, token ? { authorization: `Bearer ${token}` } : {});
  const worker = privateKeyToAccount(generatePrivateKey()).address;

  const noTok = await pay(null, { payTo: worker, amountUsdc: '0.05' });
  if (noTok.status === 401) pass('no token cannot pay');
  else fail(`unauthenticated pay returned ${noTok.status}`);

  const junk = await pay('not-a-real-token-aaaaaaaaaaaaaaaa', { payTo: worker, amountUsdc: '0.05' });
  if (junk.status === 401) pass('a made-up token cannot pay');
  else fail(`junk token returned ${junk.status}`);

  const idOnly = await pair(privateKeyToAccount(generatePrivateKey()), 'identity');
  const idPay = await pay(idOnly.token, { payTo: worker, amountUsdc: '0.05' });
  if (idPay.status === 403 && /discovery only/i.test(idPay.body.error ?? '')) {
    pass('a discovery-only link cannot pay, and says how to upgrade');
  } else fail(`identity-scope pay returned ${idPay.status}: ${idPay.body.error}`);

  const noPolicy = await pay(spendToken, { payTo: worker, amountUsdc: '0.05' });
  if (noPolicy.status === 403 && /no spend policy/i.test(noPolicy.body.error ?? '')) {
    pass('an account with no limits set cannot be spent from');
  } else fail(`no-policy pay returned ${noPolicy.status}: ${noPolicy.body.error}`);

  console.log('\n-- the limits bind on the server, not in a browser');

  const writePolicy = async (policy, allowlist) => {
    const at = new Date().toISOString();
    return api('/api/policy', {
      op: 'write', account: owner.address, issuedAt: at,
      signature: await owner.signMessage({ message: policyMsg('write', owner.address, at) }),
      policy, allowlist,
    });
  };

  const strangerWrite = await api('/api/policy', {
    op: 'write', account: owner.address, issuedAt: new Date().toISOString(),
    signature: await stranger.signMessage({ message: policyMsg('write', owner.address, new Date().toISOString()) }),
    policy: { dailyBudget: 999999, perAction: 999999, approvalThreshold: 999999, spentToday: 0, paused: false },
    allowlist: [{ id: 'x', listingId: 'x', name: 'x', address: worker, cap: 999999 }],
  });
  if (strangerWrite.status === 401) pass('a stranger cannot raise your limits');
  else fail(`stranger write returned ${strangerWrite.status}`);

  const wrote = await writePolicy(
    { dailyBudget: 1, perAction: 0.5, approvalThreshold: 0.4, spentToday: 0, paused: false },
    [{ id: 'w1', listingId: 'l1', name: 'Worker', address: worker, cap: 0.3 }],
  );
  if (wrote.status === 200 && wrote.body.saved) pass('limits saved server-side');
  else fail(`saving limits returned ${wrote.status}: ${JSON.stringify(wrote.body)}`);

  const other = privateKeyToAccount(generatePrivateKey()).address;
  const notAllowed = await pay(spendToken, { payTo: other, amountUsdc: '0.05' });
  if (notAllowed.status === 403 && /allowlist/i.test(notAllowed.body.error ?? '')) pass('paying a worker not on the allowlist is refused');
  else fail(`off-allowlist pay returned ${notAllowed.status}: ${notAllowed.body.error}`);

  const overCap = await pay(spendToken, { payTo: worker, amountUsdc: '0.4' });
  if (overCap.status === 403 && /per-call cap/i.test(overCap.body.error ?? '')) pass("over the worker's per-call cap is refused");
  else fail(`over-cap pay returned ${overCap.status}: ${overCap.body.error}`);

  await writePolicy(
    { dailyBudget: 1, perAction: 0.2, approvalThreshold: 0.15, spentToday: 0, paused: false },
    [{ id: 'w1', listingId: 'l1', name: 'Worker', address: worker, cap: 5 }],
  );
  const overAction = await pay(spendToken, { payTo: worker, amountUsdc: '0.5' });
  if (overAction.status === 403 && /per-action/i.test(overAction.body.error ?? '')) pass('over the per-action limit is refused');
  else fail(`over-action pay returned ${overAction.status}: ${overAction.body.error}`);

  const needsHuman = await pay(spendToken, { payTo: worker, amountUsdc: '0.18' });
  if (needsHuman.status === 403 && needsHuman.body.blockedBy === 'approval') {
    pass('at or above the approval threshold an agent is refused, not prompted');
  } else fail(`threshold pay returned ${needsHuman.status}: ${JSON.stringify(needsHuman.body)}`);

  await writePolicy(
    { dailyBudget: 1, perAction: 0.5, approvalThreshold: 0.9, spentToday: 0, paused: true },
    [{ id: 'w1', listingId: 'l1', name: 'Worker', address: worker, cap: 5 }],
  );
  const paused = await pay(spendToken, { payTo: worker, amountUsdc: '0.05' });
  if (paused.status === 403 && /paused/i.test(paused.body.error ?? '')) pass('paused spending refuses the agent too');
  else fail(`paused pay returned ${paused.status}: ${paused.body.error}`);

  console.log('\n-- a call that passes every limit reaches the signer');

  await writePolicy(
    { dailyBudget: 1, perAction: 0.5, approvalThreshold: 0.9, spentToday: 0, paused: false },
    [{ id: 'w1', listingId: 'l1', name: 'Worker', address: worker, cap: 5 }],
  );
  const allowed = await pay(spendToken, { payTo: worker, amountUsdc: '0.05' });
  // Privy is not configured in this harness, so getting as far as a 503 about
  // the signer proves every gate in front of it opened.
  if (allowed.status === 503 && /PRIVY/i.test(allowed.body.error ?? '')) {
    pass('a within-limits call passes policy and stops at the unconfigured signer');
  } else fail(`in-limits pay returned ${allowed.status}: ${allowed.body.error}`);

  console.log('\n-- revoking');

  const at = new Date().toISOString();
  const read = await api('/api/policy', {
    op: 'read', account: owner.address, issuedAt: at,
    signature: await owner.signMessage({ message: policyMsg('read', owner.address, at) }),
  });
  const agents = read.body.agents ?? [];
  if (agents.length >= 1) pass(`linked terminals are listed (${agents.length})`);
  else fail('no linked terminals listed');

  const at2 = new Date().toISOString();
  await api('/api/policy', {
    op: 'revoke', account: owner.address, issuedAt: at2,
    signature: await owner.signMessage({ message: policyMsg('revoke', owner.address, at2) }),
    hash: agents[0].hash,
  });
  const afterRevoke = await pay(spendToken, { payTo: worker, amountUsdc: '0.05' });
  if (afterRevoke.status === 401) pass('a revoked token stops working immediately');
  else fail(`revoked token returned ${afterRevoke.status}: ${afterRevoke.body.error}`);

} catch (e) {
  fail('threw: ' + (e?.stack ?? e));
} finally {
  try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill('SIGTERM'); }
  await sleep(300);
}

console.log(`\n${pass_} passed, ${fail_} failed`);
process.exit(fail_ ? 1 : 0);
