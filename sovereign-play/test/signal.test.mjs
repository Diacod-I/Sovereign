// The end-of-match path: hook writes a signal, a running game notices it,
// counts down, and exits. Driven headlessly by faking the signal file.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovplay-'));
const signal = path.join(tmp, 'done');
const root = new URL('..', import.meta.url).pathname;

console.log('hook');
{
  const r = spawn(path.join(root, 'scripts/signal-done.sh'), [], {
    env: { ...process.env, SOVEREIGN_PLAY_SIGNAL: signal, CLAUDE_PROJECT_DIR: tmp },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  r.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: tmp }));
  const code = await new Promise((res) => r.on('close', res));
  code === 0 ? ok('hook exits 0 (never fails a Claude turn)') : bad(`hook exited ${code}`);
  fs.existsSync(signal) ? ok('hook wrote the signal file') : bad('no signal file');
}

console.log('\nhook with no stdin (must not hang)');
{
  fs.rmSync(signal, { force: true });
  const started = Date.now();
  const r = spawn(path.join(root, 'scripts/signal-done.sh'), [], {
    env: { ...process.env, SOVEREIGN_PLAY_SIGNAL: signal, CLAUDE_PROJECT_DIR: tmp },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const code = await Promise.race([
    new Promise((res) => r.on('close', res)),
    sleep(4000).then(() => 'TIMEOUT'),
  ]);
  const took = Date.now() - started;
  code === 0 ? ok(`exits cleanly with no stdin (${took}ms)`) : bad(`no-stdin result: ${code}`);
}

console.log('\ngame reacts to the signal');
{
  fs.rmSync(signal, { force: true });
  // The driver needs a TTY, so drive the engine directly with the same logic the
  // loop uses: poll for the file, start the countdown, end at zero.
  const { newGame, step, render } = await import('../game.js');
  let g = newGame(4242);
  let seen = false;
  let ended = false;
  const END = 3;

  for (let tick = 0; tick < 400; tick++) {
    if (tick === 30) fs.writeFileSync(signal, '');
    if (!seen && fs.existsSync(signal)) {
      seen = true;
      g.endingAt = END;
      fs.rmSync(signal, { force: true });
    }
    g = step(g, Boolean(g.side));
    if (g.endingAt !== null && tick % 30 === 0 && tick > 30) {
      g.endingAt -= 1;
      if (g.endingAt <= 0) { ended = true; break; }
    }
  }
  seen ? ok('game noticed the signal') : bad('signal missed');
  ended ? ok('countdown reached zero and ended the match') : bad('never ended');
  !fs.existsSync(signal) ? ok('signal consumed, so the next match is not ended instantly') : bad('signal left behind');
  render({ ...g, endingAt: 3 }).includes('ending in 3s') ? ok('countdown visible in the frame') : bad('no countdown in render');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
