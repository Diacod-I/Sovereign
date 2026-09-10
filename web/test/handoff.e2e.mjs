// Round-trip test: sovereign-mcp encodes a handoff link, the web app decodes it.
// The MCP encodes a handoff link; the web app must decode exactly what was sent,
// and must refuse anything malformed (it is untrusted input from a URL).
const SITE = 'https://sovereign-marketplace.vercel.app';

// --- encoder, lifted from sovereign-mcp/index.js ---
function handoffLink(kind, payload) {
  const json = JSON.stringify({ v: 1, ...payload });
  const b64 = Buffer.from(json, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${SITE}/dashboard?${kind}=${b64}`;
}

// Bundle the app's own parser so this tests the real code, not a copy:
//   npx esbuild ../app/lib/receipts.ts --bundle --format=esm --outfile=/tmp/receipts.mjs
const { readHandoff } = await import(process.env.RECEIPTS_BUNDLE || '/tmp/receipts.mjs');
let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };
const qs = (url) => new URL(url).search;

// --- hire handoff (keyless: agent found it, human pays) ---
const hire = handoffLink('hire', {
  agentId: 'risk-agent', agentName: 'Address Risk Agent',
  amountUsdc: '0.12', expectation: 'sanctions + mixer exposure for 0xabc, with sources',
});
let d = readHandoff(qs(hire));
d?.kind === 'hire' ? ok('hire link decodes') : bad('hire kind: ' + d?.kind);
d?.agentId === 'risk-agent' ? ok('agentId survives') : bad('agentId ' + d?.agentId);
d?.expectation === 'sanctions + mixer exposure for 0xabc, with sources' ? ok('expectation survives verbatim') : bad('expectation mangled');
d?.amountUsdc === '0.12' ? ok('amount survives') : bad('amount ' + d?.amountUsdc);

// --- review handoff (autonomous: agent already paid) ---
const ref = '0x' + 'ab'.repeat(32);
const rev = handoffLink('review', {
  agentId: 'risk-agent', agentName: 'Address Risk Agent', amountUsdc: '0.12',
  expectation: 'a risk score', settlementRef: ref, latencyMs: 842, delivered: true,
});
d = readHandoff(qs(rev));
d?.kind === 'review' ? ok('review link decodes') : bad('review kind: ' + d?.kind);
d?.settlementRef === ref ? ok('settlementRef survives') : bad('ref ' + d?.settlementRef);
d?.latencyMs === 842 ? ok('measured latency survives (842ms)') : bad('latency ' + d?.latencyMs);
d?.delivered === true ? ok('delivered flag survives') : bad('delivered ' + d?.delivered);

// --- unicode / awkward expectations ---
const tricky = 'find “whales” — >$1M, 20% ±, emoji 🐋 & <script>alert(1)</script>';
d = readHandoff(qs(handoffLink('hire', { agentId: 'x', agentName: 'X', amountUsdc: '1', expectation: tricky })));
d?.expectation === tricky ? ok('unicode + punctuation + markup survive intact') : bad('mangled: ' + d?.expectation);

// --- malformed input must be refused, never thrown ---
console.log('\nmalformed input');
for (const [q, label] of [
  ['?review=not-base64!!', 'garbage base64'],
  ['?hire=' + Buffer.from('not json').toString('base64'), 'valid base64, not JSON'],
  ['?hire=' + Buffer.from(JSON.stringify({ v: 1 })).toString('base64'), 'JSON with no agentId'],
  ['?nothing=1', 'no handoff param'],
  ['', 'empty query'],
]) {
  let threw = false, out;
  try { out = readHandoff(q); } catch { threw = true; }
  !threw && out === null ? ok(`refused ${label}`) : bad(`${label} → threw=${threw} out=${JSON.stringify(out)}`);
}

// --- field-level validation ---
console.log('\nfield validation');
const evil = Buffer.from(JSON.stringify({
  v: 1, agentId: 'x', agentName: 'X', amountUsdc: '1e9; DROP', expectation: 'y',
  settlementRef: 'javascript:alert(1)', latencyMs: 'NaN', delivered: 'yes',
})).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
d = readHandoff('?review=' + evil);
d?.amountUsdc === '0' ? ok('non-numeric amount falls back to 0') : bad('amount ' + d?.amountUsdc);
d?.settlementRef === '' ? ok('non-hash settlementRef rejected') : bad('ref ' + d?.settlementRef);
d?.latencyMs === 0 ? ok('non-numeric latency falls back to 0') : bad('latency ' + d?.latencyMs);

const long = Buffer.from(JSON.stringify({ v:1, agentId:'x', agentName:'X', amountUsdc:'1', expectation:'z'.repeat(5000) })).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
readHandoff('?hire=' + long)?.expectation.length === 400 ? ok('oversized expectation truncated to 400') : bad('length ' + readHandoff('?hire='+long)?.expectation.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
