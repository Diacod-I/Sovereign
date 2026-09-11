// Engine tests. The point of keeping step()/render() pure is that a climber can
// be proven playable without a terminal: a skilled policy should get far, a blind
// one should not, and the world should never kill you through no fault of yours.

import { H, W, newGame, render, spikeAt, step } from '../game.js';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Look one jump ahead using the engine itself — only possible because it's pure. */
function jumpIsSafe(s) {
  let t = step(s, true);
  for (let i = 0; i < 80; i++) {
    if (t.side) return !t.dead;
    if (t.dead) return false;
    t = step(t, false);
  }
  return false;
}

function play(seed, ticks, policy) {
  let s = newGame(seed);
  for (let i = 0; i < ticks && !s.dead; i++) s = step(s, policy(s));
  return s;
}

console.log('determinism');
{
  const a = play(999, 400, (s) => Boolean(s.side));
  const b = play(999, 400, (s) => Boolean(s.side));
  a.best === b.best && a.t === b.t && a.cause === b.cause
    ? ok(`same seed replays identically (${Math.floor(a.best)}m)`)
    : bad(`diverged: ${a.best} vs ${b.best}`);
}

console.log('\nphysics');
{
  let s = newGame(1);
  const before = s.y;
  s = step(s, true);
  while (!s.side && !s.dead) s = step(s, false);
  s.y > before ? ok(`a jump gains height (+${(s.y - before).toFixed(1)}m)`) : bad(`jump LOST height: ${(s.y - before).toFixed(1)}`);
  s.side ? ok(`lands on the opposite wall (${s.side})`) : bad('never landed');
}
{
  // Idling must be fatal, or there is no pressure to climb.
  const s = play(7, 3000, () => false);
  s.dead && s.cause === 'the void' ? ok('idling is eventually fatal') : bad(`idle outcome: dead=${s.dead} cause=${s.cause}`);
}
{
  const s = newGame(3);
  const dead = { ...s, dead: true, cause: 'spikes' };
  step(dead, true) === dead ? ok('death is terminal — step() is a no-op') : bad('stepped a dead game');
}

console.log('\nis it actually playable?');
{
  // Skilled policy: only leave a wall when the landing is survivable.
  const seeds = [1, 42, 777, 31337, 8675309];
  const scores = seeds.map((sd) => Math.floor(play(sd, 4000, (s) => (s.side ? jumpIsSafe(s) : false)).best));
  const median = scores.slice().sort((a, b) => a - b)[2];
  console.log('    skilled runs:', scores.join('m, ') + 'm');
  median > 250 ? ok(`skilled play climbs far (median ${median}m)`) : bad(`skilled play capped at ${median}m — unwinnable`);

  const blind = seeds.map((sd) => Math.floor(play(sd, 4000, (s) => Boolean(s.side)).best));
  const blindMedian = blind.slice().sort((a, b) => a - b)[2];
  console.log('    blind runs:  ', blind.join('m, ') + 'm');
  blindMedian < median / 2 ? ok(`blind play does far worse (median ${blindMedian}m) — timing matters`) : bad(`blind ${blindMedian}m vs skilled ${median}m — no skill gap`);
}

console.log('\nfairness');
{
  let both = 0;
  for (let y = 0; y < 5000; y++) if (spikeAt(4242, y, 'L') && spikeAt(4242, y, 'R')) both++;
  both === 0 ? ok('no row spikes both walls (no unavoidable deaths)') : bad(`${both} rows are inescapable`);

  let early = 0;
  for (let y = 0; y < 12; y++) if (spikeAt(4242, y, 'L') || spikeAt(4242, y, 'R')) early++;
  early === 0 ? ok('first 12m are clear — room to learn the controls') : bad(`${early} spikes in the tutorial zone`);
}

console.log('\nrendering');
{
  const s = play(5, 120, (s2) => (s2.side ? jumpIsSafe(s2) : false));
  const frame = strip(render(s, { ghosts: [{ name: 'rival', best: s.best - 2 }] }));
  const lines = frame.split('\n');
  lines.length >= H + 2 ? ok(`frame has ${lines.length} lines (viewport ${H} + hud/footer)`) : bad(`only ${lines.length} lines`);
  const playfield = lines.slice(1, 1 + H);
  playfield.every((l) => l.length >= W) ? ok(`every row is at least ${W} wide`) : bad('ragged rows');
  frame.includes('@') || frame.includes('*') ? ok('player is drawn in view') : bad('player not visible in frame');
  frame.includes('rival') ? ok('rival height shown in the gutter') : bad('ghost missing');
  strip(render({ ...s, endingAt: 5 })).includes('ending in 5s') ? ok('countdown renders') : bad('countdown missing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
