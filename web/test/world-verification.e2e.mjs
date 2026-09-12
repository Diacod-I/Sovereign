// A stored demo badge must not survive the demo flag being off, and a real one
// must survive regardless.
import assert from 'node:assert';

const load = async (demoOn) => {
  const { execSync } = await import('node:child_process');
  execSync(`npx esbuild app/lib/world.ts --bundle --format=esm --platform=node --outfile=./.world.test.mjs --log-level=error --define:process.env.NEXT_PUBLIC_WORLD_DEMO='${demoOn ? '"true"' : '""'}'`, { stdio: 'inherit' });
  return import(`../.world.test.mjs?d=${demoOn}&t=${Date.now()}`);
};

// minimal localStorage
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => backing.get(k) ?? null,
  setItem: (k, v) => backing.set(k, v),
};

const KEY = 'sovereign_seller_world';
const seed = (level) => backing.set(KEY, JSON.stringify({
  '0xabc': { wallet: '0xabc', nullifierHash: level === 'demo' ? 'demo' : '0x1234', level, at: 1 },
}));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); } };

{
  const w = await load(false); // demo OFF, as on a real deployment
  seed('demo');
  t('a demo badge is not honoured when demo mode is off', () => {
    assert.equal(w.readVerification('0xabc'), null);
  });
  t('and it is cleared, not just ignored', () => {
    assert.deepEqual(JSON.parse(backing.get(KEY)), {});
  });
  seed('selfie');
  t('a real Selfie Check badge survives', () => {
    assert.equal(w.readVerification('0xabc')?.level, 'selfie');
  });
  t('a demo record on chain is refused too', () => {
    assert.equal(w.mergeVerification(null, { nullifier: '0xabc', level: 'demo', at: 1 }, '0xabc'), null);
  });
  t('a real record on chain is accepted', () => {
    assert.equal(w.mergeVerification(null, { nullifier: '0xabc', level: 'selfie', at: 1 }, '0xabc')?.onChain, true);
  });
}
{
  const w = await load(true); // demo ON, as locally
  seed('demo');
  t('a demo badge still works while demo mode is on', () => {
    assert.equal(w.readVerification('0xabc')?.level, 'demo');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
