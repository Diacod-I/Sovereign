// Probes /api/probe-fixture through /api/probe-endpoint — both live routes in the
// same app, so this is exactly what the seller dashboard will do in production.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Run against a built app: `npm run build`, then `node test/probe.fixture.e2e.mjs`.
const APP_DIR = process.env.PROBE_APP_DIR || new URL('..', import.meta.url).pathname;
const PORT = 3013;
const SELLER = '0x5E20F2ffE4f7C1a27412D53ab5C248bfef921A75';
let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const next = spawn('npx', ['next', 'start', '-p', String(PORT)], {
  cwd: APP_DIR,
  env: { ...process.env, ALLOW_PRIVATE_PROBE: 'true', NODE_ENV: 'production' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const base = `http://127.0.0.1:${PORT}`;
const probe = async (q, extra = {}) => (await fetch(`${base}/api/probe-endpoint`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ endpoint: `${base}/api/probe-fixture${q}`, payTo: SELLER, price: '0.05', ...extra }),
})).json();

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/')).status < 500) break; } catch {} await sleep(500); }

  console.log('default fixture');
  let r = await probe('');
  r.ok ? ok('verifies') : bad('should verify: ' + JSON.stringify(r.checks?.filter(c => c.status === 'fail')));
  r.quote?.amount === '50000' ? ok('quotes $0.05') : bad('amount ' + r.quote?.amount);

  const cases = [
    ['?amount=250000', 'price mismatch', 'price'],
    ['?payTo=0x1111111111111111111111111111111111111111', 'payee mismatch', 'payTo'],
    ['?mode=free', 'no paywall', 'paywalled'],
    ['?mode=noquote', 'nothing signable', 'quote'],
    ['?mode=redirect', 'redirect', 'responds'],
  ];
  for (const [q, label, checkId] of cases) {
    console.log('\n' + label);
    r = await probe(q);
    const c = r.checks?.find(x => x.id === checkId);
    !r.ok && c?.status === 'fail' ? ok(`caught (${c.detail.slice(0, 70)}…)`) : bad(`missed: ok=${r.ok} ${checkId}=${c?.status}`);
  }

  console.log('\nbody-dialect 402');
  r = await probe('?mode=body');
  r.ok ? ok('verifies') : bad('failed: ' + JSON.stringify(r.checks?.filter(c => c.status === 'fail')));

  console.log('\nslow endpoint (10s probe timeout)');
  const t = Date.now();
  r = await probe('?mode=slow');
  const dt = Date.now() - t;
  !r.ok && dt < 20000 ? ok(`timed out in ${(dt / 1000).toFixed(1)}s`) : bad(`ok=${r.ok} after ${dt}ms`);
} catch (e) { bad(e.message); console.error(e); }
finally { next.kill('SIGKILL'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
