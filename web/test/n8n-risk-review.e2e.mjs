import fs from 'node:fs';
import assert from 'node:assert';

const wf = JSON.parse(fs.readFileSync(process.env.HOME + '/mnt/sovereign/docs/n8n/dependency-risk-review.json', 'utf8'));
const code = Object.fromEntries(wf.nodes.filter(n => n.parameters.jsCode).map(n => [n.name, n.parameters.jsCode]));

// Minimal stand-in for n8n's Code node scope.
function run(src, { input, nodes = {} }) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
  return new Function('$input', '$', '"use strict";' + src)($input, $);
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } };

// --- Build request -------------------------------------------------------
let built;
t('builds a request from a packages array', () => {
  const r = run(code['Build request'], { input: { body: { input: { packages: [
    { name: 'lodash', version: '4.17.20' }, { name: 'express', version: '4.18.2' }] } } } });
  built = r[0].json;
  assert.equal(built.pkgs.length, 2);
  assert.equal(built.pkgs[0].ecosystem, 'npm');
  assert.equal(built.requestBody.temperature, 0);
  assert.match(built.requestBody.system, /Never invent an identifier/);
});

t('strips ranges from a pasted dependencies block', () => {
  const r = run(code['Build request'], { input: { body: { input: { dependencies: { lodash: '^4.17.20' } } } } });
  assert.equal(r[0].json.pkgs[0].version, '4.17.20');
});

t('refuses an empty package list instead of scanning nothing', () => {
  assert.throws(() => run(code['Build request'], { input: { body: { input: {} } } }), /Send \{/);
});

// --- Validate result -----------------------------------------------------
const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 10, output_tokens: 20 } });
const good = { assessed: [
  { package: 'lodash', version: '4.17.20', knownAdvisories: [{ id: 'CVE-2021-23337', summary: 'command injection in template', fixedIn: '4.17.21' }], severity: 'high', maintenanceRisk: 'stable', recommendation: 'upgrade', confidence: 'high' },
  { package: 'express', version: '4.18.2', knownAdvisories: [], severity: 'none', maintenanceRisk: 'active', recommendation: 'fine', confidence: 'medium' },
]};

t('shapes a well-formed review', () => {
  const r = run(code['Validate result'], { input: reply(good), nodes: { 'Build request': built } });
  const o = r[0].json.output;
  assert.equal(o.scanned, 2);
  assert.equal(o.flagged, 1);
  assert.equal(o.findings[0].package, 'lodash');
  assert.equal(o.tokens.output_tokens, 20);
  assert.match(o.caveat, /training cutoff/);
});

t('accepts a fenced JSON reply', () => {
  const fenced = { content: [{ type: 'text', text: '```json\n' + JSON.stringify(good) + '\n```' }] };
  const r = run(code['Validate result'], { input: fenced, nodes: { 'Build request': built } });
  assert.equal(r[0].json.output.flagged, 1);
});

t('counts a low-confidence all-clear as something the buyer must see', () => {
  const shaky = { assessed: good.assessed.map(a => ({ ...a, severity: 'none', knownAdvisories: [], confidence: 'low' })) };
  const r = run(code['Validate result'], { input: reply(shaky), nodes: { 'Build request': built } });
  assert.equal(r[0].json.output.flagged, 0);
  assert.equal(r[0].json.output.lowConfidence, 2);
});

t('refuses when the model skips a package', () => {
  const short = { assessed: [good.assessed[0]] };
  assert.throws(() => run(code['Validate result'], { input: reply(short), nodes: { 'Build request': built } }), /skipped 1 package/);
});

t('refuses a non-JSON reply instead of reporting clean', () => {
  const prose = { content: [{ type: 'text', text: 'Sure! Here is what I found: everything looks fine.' }] };
  assert.throws(() => run(code['Validate result'], { input: prose, nodes: { 'Build request': built } }), /did not return JSON/);
});

t('refuses an Anthropic error body', () => {
  assert.throws(() => run(code['Validate result'], { input: { type: 'error', error: { message: 'overloaded' } }, nodes: { 'Build request': built } }), /returned an error/);
});

t('refuses a truncated reply', () => {
  const cut = { content: [{ type: 'text', text: '{"assessed":[' }], stop_reason: 'max_tokens' };
  assert.throws(() => run(code['Validate result'], { input: cut, nodes: { 'Build request': built } }), /max_tokens/);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
