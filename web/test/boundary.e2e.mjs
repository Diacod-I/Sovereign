#!/usr/bin/env node
// Server code must not import client-only modules.
//
// Next turns a 'use client' module into a client reference proxy when a server
// module imports it. That builds cleanly, typechecks cleanly, and throws the
// first time the server actually calls the function -- so it surfaces in
// production, on whichever path is least exercised. It cost a live payment run
// here: x402-pay.server.ts imported a balance check out of a module marked
// 'use client', and the failure reached a buyer as "a bug in the marketplace".
//
// esbuild ignores the directive entirely, which is why the existing e2e tests
// bundled the same code and passed. This check reads the directive itself.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'app');

/** Every .ts/.tsx under app/, with its source. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);

const isClient = (src) => /^\s*(['"])use client\1/m.test(src.split('\n').slice(0, 5).join('\n'));

const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const clientModules = new Set([...sources].filter(([, s]) => isClient(s)).map(([f]) => f));

/** A module that runs on the server: *.server.ts, or anything under app/api/. */
const isServer = (f) => /\.server\.tsx?$/.test(f) || f.includes(`${path.sep}api${path.sep}`);

const problems = [];
for (const [file, src] of sources) {
  if (!isServer(file)) continue;
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const resolved = path.resolve(path.dirname(file), spec + ext);
      if (clientModules.has(resolved)) {
        problems.push(`${path.relative(process.cwd(), file)}\n    imports ${spec} which is 'use client'`);
      }
    }
  }
}

console.log('');
console.log(`  scanned ${files.length} files, ${clientModules.size} of them client-only`);
if (problems.length) {
  console.log('');
  problems.forEach((p) => console.log(`  FAIL ${p}`));
  console.log(`\n  ${problems.length} server module(s) importing client-only code.`);
  console.log('  These build and typecheck, and throw when the server calls them.\n');
  process.exit(1);
}
console.log('  ok    no server module imports a client-only module\n');
