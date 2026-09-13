#!/usr/bin/env node
// Checks a live Sovereign deployment before you demo against it.
//
//   node test/preflight.mjs                      (the deployed site)
//   node test/preflight.mjs http://localhost:3000
//
// Everything here is a GET against public endpoints. It reads configuration
// state and reachability; it never spends, signs or writes.

const SITE = (process.argv[2] || process.env.SOVEREIGN_SITE_URL || 'https://sovereign-marketplace.vercel.app')
  .replace(/\/+$/, '');
const SUBGRAPH = process.env.SUBGRAPH_URL
  || 'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

const g = (s) => `\x1b[92m${s}\x1b[0m`;
const r = (s) => `\x1b[91m${s}\x1b[0m`;
const y = (s) => `\x1b[93m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const mark = (state) => (state === true ? g('  ok  ') : state === false ? r(' FAIL ') : y(' warn '));
const rows = [];
const add = (state, label, note = '') => rows.push({ state, label, note });

const timeout = (ms) => AbortSignal.timeout(ms);

console.log(`\nPreflight: ${SITE}\n`);

// ---- what the deployment says about itself -------------------------------
let health = null;
try {
  const res = await fetch(`${SITE}/api/health`, { signal: timeout(10000) });
  if (res.ok) health = await res.json();
  else add(false, 'Health endpoint', `HTTP ${res.status}. Deployed before this route existed?`);
} catch (e) {
  add(false, 'Site reachable', e.message);
}

if (health) {
  const c = health.checks;
  add(true, 'Site reachable');
  add(c.durableStorage, 'Durable storage (Upstash)',
    c.durableStorage ? '' : 'Workers vanish on a cold start. Set UPSTASH_REDIS_REST_URL and _TOKEN.');
  add(c.agentPayments, 'Privy variables set',
    c.agentPayments ? '' : 'Claude Code cannot pay. Set PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_KEY.');
  // The one that predicts whether a payment actually succeeds. Set means set;
  // this means Privy accepted them.
  add(
    c.privyCredentialsValid === undefined ? null : c.privyCredentialsValid,
    'Privy credentials ACCEPTED',
    c.privyCredentialsValid === undefined
      ? 'not reported — redeploy to see it'
      : c.privyCredentialsValid
        ? 'Privy accepted the app id + secret pair'
        : 'Privy REJECTED them. See blocking below.',
  );
  // `undefined` means this deployment predates the field; `null`/'' means it is
  // genuinely unset. Collapsing the two reports a stale deployment as a missing
  // variable, which is a false alarm that costs more than the check saves.
  add(
    c.privyAppId === undefined ? null : !!c.privyAppId,
    'Privy app id',
    c.privyAppId === undefined
      ? 'not reported — deployment predates this check, redeploy to see it'
      : c.privyAppId
        ? `${c.privyAppId} — the quorum and the users must be in THIS app`
        : 'not set',
  );
  add(c.privySignerId, 'Privy signer id (link --spend)',
    c.privySignerId ? '' : 'Approving a spend link will hang. Set NEXT_PUBLIC_PRIVY_SIGNER_ID.');
  // Only needed to SEAL a seller's upstream API key. Workers whose upstream
  // needs no auth (OSV, the OFAC list) never touch it, so this is a warning
  // rather than a failure.
  add(c.workerSecrets ? true : null, 'Worker secret sealing',
    c.workerSecrets ? '' : 'Only needed for workers whose upstream requires an API key.');
  // This one IS blocking: without it the x402 middleware cannot get Gateway to
  // quote payment terms, so a hosted worker never returns a payable 402.
  add(c.circleApiKey, 'Circle API key',
    c.circleApiKey ? '' : 'Hosted workers cannot quote payment terms without it.');
  add(c.onChainVerification ? true : null, 'On-chain World ID',
    c.onChainVerification ? '' : 'Badges stay local to the browser. Optional for a payment demo.');
  // Blocking, and easy to miss, because nothing fails until a buyer has already
  // paid and wants to say the work was bad.
  add(c.onChainReceipts === undefined ? null : c.onChainReceipts, 'Grading (Receipts contract)',
    c.onChainReceipts === undefined
      ? 'This deployment predates the check. Redeploy to see it.'
      : c.onChainReceipts
        ? ''
        : 'NEXT_PUBLIC_RECEIPTS_ADDRESS is unset or malformed. Every review will refuse to submit.');
  // This one is inverted: true is bad.
  add(!c.worldDemoBypass, 'World demo bypass is OFF',
    c.worldDemoBypass ? 'NEXT_PUBLIC_WORLD_DEMO is on. Anyone can mark themselves verified.' : '');
  add(true, 'Listings curated out', `${c.curatedOut}`);
}

// ---- the registry ---------------------------------------------------------
let agents = [];
try {
  const res = await fetch(SUBGRAPH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ agents(where: { active: true }, first: 50) { id name endpoint pricePerCall owner } }' }),
    signal: timeout(10000),
  });
  const json = await res.json();
  if (json.errors) throw new Error('subgraph returned errors');
  agents = json.data?.agents ?? [];
  add(true, 'Registry reachable', `${agents.length} active listing(s)`);
} catch (e) {
  add(false, 'Registry reachable', e.message);
}

// ---- curation, and whether the two agree ---------------------------------
let hidden = new Set();
try {
  const res = await fetch(`${SITE}/api/curation`, { signal: timeout(8000) });
  const json = await res.json();
  hidden = new Set((json.hidden || []).map((s) => String(s).toLowerCase()));
  const servable = agents.filter((a) => !hidden.has(a.id.toLowerCase()));
  add(true, 'Curation list', `${hidden.size} hidden, ${servable.length} servable`);
  if (agents.length && !servable.length) {
    add(false, 'Something to buy', 'Every active listing is curated out.');
  }
} catch (e) {
  add(null, 'Curation list', e.message);
}

// ---- do the servable endpoints actually answer? ---------------------------
// An unpaid POST should be 402. Anything else is a listing whose service has
// gone, which is the failure that cost real money earlier in this build.
for (const a of agents.filter((x) => !hidden.has(x.id.toLowerCase()))) {
  const price = (Number(a.pricePerCall) / 1e6).toString();
  try {
    const res = await fetch(a.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
      signal: timeout(15000),
    });
    if (res.status === 402) {
      add(true, `${a.name}`, `${price} USDC, paywall live`);
    } else if (res.ok) {
      add(null, `${a.name}`, `answered HTTP 200 unpaid: not x402-gated, so it serves for free`);
    } else {
      add(false, `${a.name}`, `HTTP ${res.status} — listed but not serving`);
    }
  } catch (e) {
    add(false, `${a.name}`, `unreachable: ${e.message}`);
  }
}

// ---- report ---------------------------------------------------------------
const width = Math.max(...rows.map((x) => x.label.length));
for (const { state, label, note } of rows) {
  console.log(`${mark(state)} ${label.padEnd(width)}  ${note ? dim(note) : ''}`);
}

const failed = rows.filter((x) => x.state === false).length;
const warned = rows.filter((x) => x.state === null).length;
console.log(`\n${failed ? r(`${failed} blocking`) : g('nothing blocking')}${warned ? `, ${y(`${warned} to look at`)}` : ''}\n`);

if (!failed) {
  console.log(dim('  Not checked here, because they are per-account rather than per-deployment:'));
  console.log(dim('    - your Gateway spending balance (Overview, Top up agent spending)'));
  console.log(dim('    - whether the worker is on your allowlist'));
  console.log(dim('    - whether this terminal is paired (npx sovereign-mcp@latest link --spend)\n'));
}

process.exit(failed ? 1 : 0);
