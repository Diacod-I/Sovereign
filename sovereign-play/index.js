#!/usr/bin/env node
// sovereign-play — climb a tower in your terminal while Claude Code works.
//
// Run it in a second pane. When Claude finishes, a Stop hook touches a signal
// file, the match ends on a short countdown, and you go back and read the diff.
//
//   sovereign-play                      single player
//   sovereign-play --host 7777          host a race
//   sovereign-play --join 192.168.1.5:7777
//   sovereign-play --demo 400           headless; prints a frame (for tests/CI)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { H, newGame, render, step } from './game.js';
import { host as hostGame, join as joinGame } from './net.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : null;
};
const has = (name) => args.includes(name);

// Where the Claude Code hook drops its signal. Overridable so several projects
// can run side by side without ending each other's matches.
const SIGNAL =
  process.env.SOVEREIGN_PLAY_SIGNAL ||
  path.join(process.cwd(), '.claude', 'sovereign-play.done');

const TICK_MS = 33;              // ~30fps; the physics constants assume this
const END_SECONDS = Number(process.env.SOVEREIGN_PLAY_COUNTDOWN || 7);

// ---------------------------------------------------------------- headless
// Used by the tests and by `--demo`: run N ticks with a simple autopilot that
// jumps whenever it is clinging, then print the final frame. No terminal needed.
if (flag('--demo') !== null) {
  const ticks = Number(flag('--demo')) || 300;
  let s = newGame(Number(process.env.SEED) || 12345);
  for (let i = 0; i < ticks && !s.dead; i++) s = step(s, Boolean(s.side));
  process.stdout.write(render(s, { ghosts: [{ name: 'ghost', best: s.best - 3 }] }) + '\n');
  process.stdout.write(`\nticks=${s.t} best=${Math.floor(s.best)} dead=${s.dead} cause=${s.cause}\n`);
  process.exit(0);
}

if (!process.stdout.isTTY) {
  console.error('sovereign-play needs an interactive terminal. Try --demo 300 for a headless frame.');
  process.exit(1);
}

// ---------------------------------------------------------------- terminal
const out = (str) => process.stdout.write(str);
const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?1049l\x1b[?25h';

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try { process.stdin.setRawMode(false); } catch {}
  out(ALT_OFF);
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(0); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

// ---------------------------------------------------------------- net
const name = (flag('--name') || os.userInfo().username || 'you').slice(0, 12);
let seed = Number(flag('--seed')) || ((Math.random() * 1e9) | 0);
let ghosts = [];
let link = null;
let waiting = false;

if (has('--host')) {
  const port = Number(flag('--host')) || 7777;
  link = hostGame(port, seed, name, (peers) => { ghosts = peers; });
  waiting = true;
} else if (has('--join')) {
  const [h, p] = (flag('--join') || '').split(':');
  if (!h) { console.error('usage: --join <host:port>'); process.exit(1); }
  waiting = true;
  link = joinGame(h, Number(p) || 7777, name,
    (s) => { seed = s; game = newGame(seed); waiting = false; },
    (peers) => { ghosts = peers; },
    () => { if (game.endingAt === null) game.endingAt = END_SECONDS; },
  );
}

// ---------------------------------------------------------------- loop
let game = newGame(seed);
let jumpQueued = false;
let quit = false;

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buf) => {
  const k = buf.toString();
  if (k === 'q' || k === '') { quit = true; return; }
  if (k === 'r' && game.dead) { game = newGame(seed); return; }
  if (k === ' ' || k === '\r') jumpQueued = true;
});

out(ALT_ON);

// The signal file is how Claude Code tells us it is finished. Polling a file is
// unglamorous but it works across every shell, needs no port, and survives the
// game being started before or after Claude.
let signalSeen = false;
function checkSignal() {
  if (signalSeen) return;
  try {
    if (fs.existsSync(SIGNAL)) {
      signalSeen = true;
      if (game.endingAt === null) game.endingAt = END_SECONDS;
      if (link?.broadcast) { try { link.broadcast(game.best, END_SECONDS); } catch {} }
      try { fs.unlinkSync(SIGNAL); } catch {}
    }
  } catch {}
}

let tickCount = 0;
const timer = setInterval(() => {
  if (quit) return finish();
  tickCount++;

  if (tickCount % 15 === 0) checkSignal();

  if (!waiting) {
    game = step(game, jumpQueued);
    jumpQueued = false;

    if (game.endingAt !== null && tickCount % Math.round(1000 / TICK_MS) === 0) {
      game.endingAt -= 1;
      if (game.endingAt <= 0) return finish();
    }
    if (tickCount % 6 === 0 && link?.broadcast) {
      try { link.broadcast(game.best, game.endingAt ?? 0); } catch {}
    }
  }

  const status = waiting ? '\x1b[2mwaiting for the other climber…\x1b[0m' : '';
  out('\x1b[H' + render(game, { ghosts, status }) + '\x1b[J');
}, TICK_MS);

function finish() {
  clearInterval(timer);
  restore();
  try { link?.close(); } catch {}

  const all = [{ name, best: game.best }, ...ghosts].sort((a, b) => b.best - a.best);
  console.log('');
  console.log(`  ▲ ${Math.floor(game.best)}m`);
  if (ghosts.length) {
    console.log('');
    all.forEach((p, i) => console.log(`  ${i + 1}. ${p.name.padEnd(14)} ${Math.floor(p.best)}m`));
  }
  console.log(signalSeen ? '\n  Claude is done — back to work.\n' : '');
  process.exit(0);
}
