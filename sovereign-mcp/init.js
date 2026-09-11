#!/usr/bin/env node
// `npx sovereign-mcp init` — wires Sovereign into the current project.
//
// Deliberately a command the user runs, not an npm postinstall hook. A package
// that writes into your project during `npm install` is bad manners, silently
// skipped under --ignore-scripts, and has no project to write to when installed
// globally or run through npx. Explicit beats clever here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const SUBGRAPH =
  process.env.SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

const g = (s) => `\x1b[92m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const y = (s) => `\x1b[93m${s}\x1b[0m`;

const FORCE = process.argv.includes('--force');
const HERE_OK = process.argv.includes('--here');
let wrote = 0, skipped = 0;

/**
 * Refuse to scatter config into a directory that is not a project.
 *
 * `init` writes relative to CWD, so running it one level too high — in the folder
 * that *contains* your repo, say — silently creates a .claude/ and .mcp.json that
 * Claude Code will never read from the project you actually work in. Easy mistake,
 * and invisible afterwards, so it is worth a hard stop.
 */
const MARKERS = ['package.json', '.git', '.claude', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

/** Walks up looking for the repo root, so we can tell "a project" from "the project". */
function gitRoot(from) {
  let dir = from;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// A subdirectory that happens to hold a package.json still passes the marker
// test — `sovereign-mcp/` inside the repo, say — but installing there puts the
// skill somewhere Claude Code will not read when you work from the repo root.
// Being inside a repo but not at its root is almost always the wrong place.
const root = gitRoot(CWD);
if (!HERE_OK && root && path.resolve(root) !== path.resolve(CWD)) {
  console.error('');
  console.error(`  ${y('You are in a subdirectory of a repo, not its root.')}`);
  console.error(`  ${dim('here: ' + CWD)}`);
  console.error(`  ${dim('root: ' + root)}`);
  console.error('');
  console.error('  Claude Code reads .claude/skills from the directory you launch it in,');
  console.error('  so installing here would be invisible from the repo root.');
  console.error('');
  console.error(`  ${g('cd ' + (path.relative(CWD, root) || '.'))} and re-run, or pass ${g('--here')} if you meant this folder.`);
  console.error('');
  process.exit(1);
}

if (!HERE_OK && !MARKERS.some((m) => fs.existsSync(path.join(CWD, m)))) {
  console.error('');
  console.error(`  ${y('This does not look like a project directory.')}`);
  console.error(`  ${dim(CWD)}`);
  console.error('');
  console.error('  Nothing here looks like a project root (no package.json, .git, .claude …).');
  console.error('  Claude Code reads .claude/skills from the directory you run it in, so');
  console.error('  installing here would have no effect where you actually work.');
  console.error('');
  console.error(`  cd into your project and re-run, or pass ${g('--here')} if this is right.`);
  console.error('');
  process.exit(1);
}

function write(rel, contents, { merge } = {}) {
  const dest = path.join(CWD, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.trim() === contents.trim()) {
      console.log(`  ${dim('unchanged')} ${rel}`);
      skipped++;
      return;
    }
    if (!merge && !FORCE) {
      // Never clobber a file the user may have edited. Leave theirs in place and
      // drop ours beside it so they can diff and take what they want.
      fs.writeFileSync(dest + '.sovereign-new', contents);
      console.log(`  ${y('kept yours')} ${rel} ${dim('→ ours at ' + rel + '.sovereign-new (--force to replace)')}`);
      skipped++;
      return;
    }
  }
  fs.writeFileSync(dest, contents);
  console.log(`  ${g('wrote')}     ${rel}`);
  wrote++;
}

// 1. The skill — what makes Claude reach for the marketplace unprompted.
const skill = fs.readFileSync(path.join(HERE, 'skills/sovereign-marketplace/SKILL.md'), 'utf8');
write('.claude/skills/sovereign-marketplace/SKILL.md', skill);

// 2. The MCP server registration, merged into any existing .mcp.json.
const mcpPath = path.join(CWD, '.mcp.json');
let mcp = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch {}
  mcp.mcpServers ||= {};
}
if (mcp.mcpServers.sovereign) {
  console.log(`  ${dim('unchanged')} .mcp.json ${dim('(sovereign already registered)')}`);
  skipped++;
} else {
  mcp.mcpServers.sovereign = {
    command: 'npx',
    args: ['-y', 'sovereign-mcp'],
    env: { SUBGRAPH_URL: SUBGRAPH },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  console.log(`  ${g('wrote')}     .mcp.json ${dim('(merged)')}`);
  wrote++;
}

console.log('');
console.log(`  ${wrote} written, ${skipped} left alone.`);
console.log('');
console.log(`  ${g('Restart Claude Code')} to load the skill, then try:`);
console.log(dim('    "find me agents that can do market research on whale wallets"'));
console.log('');
