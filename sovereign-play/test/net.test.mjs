// Multiplayer over a real socket: the host's seed must reach the joiner (same
// tower), and heights must flow both ways (ghost markers).

import { setTimeout as sleep } from 'node:timers/promises';
import { host, join } from '../net.js';
import { newGame, step } from '../game.js';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const PORT = 7911;
const SEED = 123456;

let hostSawPeers = [];
const h = host(PORT, SEED, 'host', (peers) => { hostSawPeers = peers; });
await sleep(200);

let joinerSeed = null;
let joinerSawPeers = [];
let joinerEnding = null;
const j = join('127.0.0.1', PORT, 'joiner',
  (s) => { joinerSeed = s; },
  (p) => { joinerSawPeers = p; },
  (e) => { joinerEnding = e; },
);
await sleep(300);

joinerSeed === SEED ? ok(`joiner received the host's seed (${SEED}) — same tower`) : bad(`seed ${joinerSeed}`);

// Both climb their own copy; only heights cross the wire.
let a = newGame(SEED), b = newGame(joinerSeed ?? SEED);
for (let i = 0; i < 120; i++) { a = step(a, Boolean(a.side)); b = step(b, Boolean(b.side)); }
Math.floor(a.best) === Math.floor(b.best)
  ? ok(`identical seeds produce an identical world (${Math.floor(a.best)}m both)`)
  : bad(`worlds diverged: ${a.best} vs ${b.best}`);

j.broadcast(a.best);
await sleep(250);
hostSawPeers.some((p) => p.name === 'joiner' && Math.floor(p.best) === Math.floor(a.best))
  ? ok(`host sees the joiner's height (${Math.floor(a.best)}m)`)
  : bad(`host peers: ${JSON.stringify(hostSawPeers)}`);

h.broadcast(b.best, 0);
await sleep(250);
joinerSawPeers.some((p) => p.name === 'host')
  ? ok('joiner sees the host in the gutter')
  : bad(`joiner peers: ${JSON.stringify(joinerSawPeers)}`);

// The host ending the match must propagate.
h.broadcast(b.best, 7);
await sleep(250);
joinerEnding === 7 ? ok('host ending the match propagates to the joiner') : bad(`ending=${joinerEnding}`);

// A joiner dropping must not take the host down.
j.close();
await sleep(300);
hostSawPeers.length === 0 ? ok('host survives a disconnect and drops the ghost') : bad(`peers after drop: ${hostSawPeers.length}`);

h.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
