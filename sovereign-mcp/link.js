#!/usr/bin/env node
// `npx sovereign-mcp@latest link` — the one command.
//
// It does what `init` did (write the skill, register the MCP server) and then
// pairs the project with a Sovereign account, so the marketplace knows whose
// wallet this terminal speaks for.
//
// The pairing is a device-code flow. The terminal prints a short code and opens
// a browser; you approve there, signed in as yourself; the terminal collects a
// token. Nothing is typed into the terminal, no key is exported, and the code
// shown in both places is what lets you tell your own session apart from one
// somebody else started and sent you a link to.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();

const SITE =
  process.env.SOVEREIGN_SITE_URL || 'https://sovereign-marketplace.vercel.app';
const SUBGRAPH =
  process.env.SUBGRAPH_URL ||
  'https://api.studio.thegraph.com/query/1758796/sovereign-registry/version/latest';

const g = (s) => `\x1b[92m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const y = (s) => `\x1b[93m${s}\x1b[0m`;
const b = (s) => `\x1b[1m${s}\x1b[0m`;

/** `--spend` asks for autonomous payment. Without it, payment stays in the browser. */
const WANTS_SPEND = process.argv.includes('--spend');
const SCOPE = WANTS_SPEND ? 'spend' : 'identity';

function open(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    return true;
  } catch {
    return false;
  }
}

async function api(body) {
  const res = await fetch(`${SITE}/api/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runLink({ writeFiles }) {
  // 1. The local half of the proof. The hash goes up now; the secret only when
  //    collecting, so knowing the code is never enough to take the token.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');

  const label = `${path.basename(CWD)} on ${process.env.USER || process.env.USERNAME || 'this machine'}`;

  let started;
  try {
    started = await api({ op: 'start', challenge, label, scope: SCOPE });
  } catch (e) {
    console.error('');
    console.error(`  ${y('Could not reach Sovereign')} — ${e.message}`);
    console.error(dim(`  ${SITE} may be down, or you are offline.`));
    console.error('');
    process.exit(1);
  }

  const url = `${SITE}/link?code=${encodeURIComponent(started.code)}`;

  console.log('');
  console.log(`  Approve this terminal:  ${b(started.code)}`);
  console.log('');
  console.log(`  ${dim(url)}`);
  if (!open(url)) console.log(`  ${dim('Open that link to continue.')}`);
  console.log('');
  console.log(dim('  Waiting for approval… (ctrl-c to cancel)'));

  // 2. Poll. Two seconds is fast enough to feel immediate and slow enough not to
  //    look like an attack on our own API.
  const deadline = Date.now() + 10 * 60 * 1000;
  let result = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    let r;
    try {
      r = await api({ op: 'collect', code: started.code, verifier });
    } catch {
      continue; // a blip should not end a pairing the human is mid-way through
    }
    if (r.state === 'approved') { result = r; break; }
    if (r.state === 'denied') {
      console.log('');
      console.log(`  ${y('Rejected in the browser.')} Nothing was linked.`);
      console.log('');
      process.exit(1);
    }
    if (r.state === 'expired') break;
  }

  if (!result) {
    console.log('');
    console.log(`  ${y('That code expired.')} Run the command again.`);
    console.log('');
    process.exit(1);
  }

  writeFiles(result);

  const short = `${result.account.slice(0, 6)}…${result.account.slice(-4)}`;
  console.log('');
  console.log(`  ${g('Linked')} to ${short}`);
  console.log('');
  if (result.scope === 'spend') {
    console.log('  Claude can now pay workers from that wallet, inside your spend');
    console.log('  limits and only to workers on your allowlist.');
  } else {
    console.log('  Claude can search the marketplace and read track records.');
    console.log('  Paying opens your browser to confirm.');
    console.log(dim('  Add --spend to let it pay on its own.'));
  }
  console.log('');
  console.log(`  ${g('Restart Claude Code')} to load the skill, then try:`);
  console.log(dim('    "find me an agent that can screen a wallet address"'));
  console.log('');
}

/** Writes the skill + .mcp.json, carrying the pairing into the server's env. */
export function writeProjectFiles(result) {
  const skillPath = path.join(HERE, 'skills/sovereign-marketplace/SKILL.md');
  const skillDest = path.join(CWD, '.claude/skills/sovereign-marketplace/SKILL.md');
  fs.mkdirSync(path.dirname(skillDest), { recursive: true });
  fs.writeFileSync(skillDest, fs.readFileSync(skillPath, 'utf8'));
  console.log(`  ${g('wrote')}     .claude/skills/sovereign-marketplace/SKILL.md`);

  const mcpPath = path.join(CWD, '.mcp.json');
  let mcp = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch {}
    mcp.mcpServers ||= {};
  }
  mcp.mcpServers.sovereign = {
    command: 'npx',
    args: ['-y', 'sovereign-mcp'],
    env: {
      SUBGRAPH_URL: SUBGRAPH,
      SOVEREIGN_SITE_URL: SITE,
      SOVEREIGN_ACCOUNT: result.account,
      SOVEREIGN_LINK_TOKEN: result.token,
    },
  };
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  console.log(`  ${g('wrote')}     .mcp.json ${dim('(merged)')}`);

  // The token is a bearer credential for this account. Committing it would hand
  // anyone with repo access the ability to spend, so say so once, loudly, and
  // offer the one-line fix rather than assuming a .gitignore exists.
  const gitignore = path.join(CWD, '.gitignore');
  const ignored = fs.existsSync(gitignore) && /^\.mcp\.json$/m.test(fs.readFileSync(gitignore, 'utf8'));
  if (!ignored) {
    console.log('');
    console.log(`  ${y('.mcp.json now holds a token for your account.')}`);
    console.log(dim('  Keep it out of git:  echo ".mcp.json" >> .gitignore'));
  }
}
