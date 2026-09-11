// sovereign-play — engine for a one-button wall-jump climber.
//
// Everything here is pure: `step()` takes state and returns state, `render()`
// takes state and returns a string. No I/O, no timers, no terminal. That is what
// makes the thing testable headlessly — the driver in index.js supplies the
// clock and the keyboard, and nothing else.

export const W = 30;           // playfield width, walls included
export const H = 22;           // visible rows
const LEFT = 1;                // x of the left wall's climbable face
const RIGHT = W - 2;           // x of the right wall's climbable face

// Tuned, not guessed. A jump only gains height if the crossing finishes before
// the arc peaks — T = gap/vx must stay under 2*vy/g. At gap 26 and g 0.055 that
// means vx above 0.84, or every leap quietly loses altitude and the void wins no
// matter how well you play. These give ~9m per jump over ~0.67s.
const GRAVITY = 0.055;
const JUMP_VY = 1.0;           // upward kick when leaping off a wall
const JUMP_VX = 1.3;           // horizontal speed across the gap
const CLING_SLIDE = 0.09;      // you slide while clinging — that is the aiming mechanic
const VOID_BASE = 0.018;       // how fast the floor chases you
const VOID_RAMP = 0.0000075;   // …and how much worse it gets with height

/** Deterministic hash → [0,1). Same seed + row always yields the same world. */
function rnd(seed, y, salt = 0) {
  let h = (seed ^ (y * 374761393) ^ (salt * 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Is there a spike at this wall row?
 *
 * Density climbs with altitude, but rows below 12 are always clear so the first
 * few seconds are winnable while you work out the controls. Both walls are never
 * spiked at the same row — that would be an unavoidable death, and a climber that
 * kills you through no fault of your own stops being fun immediately.
 */
export function spikeAt(seed, y, side) {
  const row = Math.floor(y);
  if (row < 12) return false;
  const density = Math.min(0.42, 0.1 + row * 0.0009);
  const here = rnd(seed, row, side === 'L' ? 1 : 2) < density;
  if (!here) return false;
  const other = rnd(seed, row, side === 'L' ? 2 : 1) < density;
  // Tie broken deterministically so both clients agree on the same world.
  if (other && side === 'R') return false;
  return true;
}

export function newGame(seed = (Math.random() * 1e9) | 0) {
  return {
    seed,
    t: 0,
    x: LEFT,
    y: 2,
    vx: 0,
    vy: 0,
    side: 'L',          // which wall we are clinging to, null while airborne
    best: 2,
    voidY: -6,
    dead: false,
    cause: null,
    // Set by the driver when Claude Code finishes; counts down then ends.
    endingAt: null,
  };
}

/**
 * Advance one tick. `jump` is true on the frame the player pressed the button.
 * Jumping is only possible while clinging, which is the whole game: you choose
 * *when* to leave a wall, and the arc is fixed.
 */
export function step(s, jump) {
  if (s.dead) return s;
  const n = { ...s, t: s.t + 1 };

  if (n.side) {
    if (jump) {
      n.vy = JUMP_VY;
      n.vx = n.side === 'L' ? JUMP_VX : -JUMP_VX;
      n.side = null;
    } else {
      n.y -= CLING_SLIDE;
    }
  }

  if (!n.side) {
    n.vy -= GRAVITY;
    n.y += n.vy;
    n.x += n.vx;

    if (n.x <= LEFT) { n.x = LEFT; n.side = 'L'; n.vx = 0; n.vy = 0; }
    else if (n.x >= RIGHT) { n.x = RIGHT; n.side = 'R'; n.vx = 0; n.vy = 0; }

    // Landing on a spiked row is the only way a wall kills you.
    if (n.side && spikeAt(n.seed, n.y, n.side)) {
      n.dead = true;
      n.cause = 'spikes';
    }
  }

  n.best = Math.max(n.best, n.y);
  n.voidY += VOID_BASE + n.best * VOID_RAMP;

  if (!n.dead && n.y < n.voidY) {
    n.dead = true;
    n.cause = 'the void';
  }
  return n;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const CYAN = '\x1b[96m';

/**
 * Draw the viewport as one string. Rows are built top-down from the camera, and
 * the whole frame is returned in one piece so the driver can write it with a
 * single syscall — writing per-cell is what makes terminal games flicker.
 *
 * `ghosts` are other players' heights, drawn as markers in the right gutter.
 */
export function render(s, { ghosts = [], status = '' } = {}) {
  const camY = Math.max(0, Math.floor(s.y) - 7);
  const px = Math.round(s.x);
  const py = Math.floor(s.y);
  const rows = [];

  for (let r = H - 1; r >= 0; r--) {
    const y = camY + r;
    let line = '';
    for (let x = 0; x < W; x++) {
      if (y <= Math.floor(s.voidY)) { line += RED + '≈' + RESET; continue; }
      if (x === px && y === py) { line += GREEN + (s.side ? '@' : '*') + RESET; continue; }
      if (x === LEFT - 1 || x === RIGHT + 1) { line += DIM + '│' + RESET; continue; }
      if (x === LEFT || x === RIGHT) {
        const side = x === LEFT ? 'L' : 'R';
        line += spikeAt(s.seed, y, side) ? RED + '^' + RESET : DIM + '┊' + RESET;
        continue;
      }
      line += ' ';
    }

    // Right gutter: where everyone else has reached.
    const here = ghosts.filter((g) => Math.floor(g.best) >= y && Math.floor(g.best) < y + 1);
    line += here.length ? ' ' + CYAN + '◄ ' + here.map((g) => g.name).join(', ') + RESET : '';
    rows.push(line);
  }

  const hud = `${GREEN}▲ ${Math.floor(s.best)}m${RESET}   ${DIM}void ${Math.max(0, Math.floor(s.voidY))}m${RESET}`;
  const ghostLine = ghosts.length
    ? DIM + ghosts.map((g) => `${g.name} ${Math.floor(g.best)}m`).join('  ') + RESET
    : '';

  let footer;
  if (s.dead) {
    footer = `${RED}fell to ${s.cause} at ${Math.floor(s.best)}m${RESET}  ${DIM}r restart · q quit${RESET}`;
  } else if (s.endingAt !== null) {
    footer = `${YELLOW}Claude is done — ending in ${s.endingAt}s${RESET}`;
  } else {
    footer = `${DIM}space jump · q quit${RESET}`;
  }

  return [hud, ...rows, ghostLine, footer, status].filter((l) => l !== '').join('\n');
}
