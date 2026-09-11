// web/test/ssrf.e2e.mjs
//
// Two routes now fetch a URL a stranger supplied, from inside our own
// infrastructure: the listing probe, and the hosted worker proxy. Either is an
// SSRF primitive without a guard, and the reward for getting it wrong is not
// subtle — 169.254.169.254 hands out cloud credentials to anything that can make
// the server ask.
//
// The guard is one file both routes import, so it is worth testing directly
// rather than through a route that also needs a running server.
//
//   npm run test:ssrf

import { ipIsPrivate, assertFetchableUrl } from '/tmp/ssrf.mjs';

let pass_ = 0, fail_ = 0;
const check = (name, cond) => { if (cond) { pass_++; console.log('  ✓ ' + name); } else { fail_++; console.error('  ✗ ' + name); process.exitCode = 1; } };

console.log('SSRF guard\n');

console.log('-- addresses that must never be fetched');
for (const [ip, why] of [
  ['169.254.169.254', 'cloud metadata'],
  ['127.0.0.1', 'loopback'],
  ['10.0.0.5', 'private class A'],
  ['172.16.0.1', 'private class B'],
  ['172.31.255.254', 'private class B, top of range'],
  ['192.168.1.1', 'private class C'],
  ['100.64.0.1', 'CGNAT'],
  ['0.0.0.0', 'this-network'],
  ['224.0.0.1', 'multicast'],
  ['::1', 'IPv6 loopback'],
  ['fd00::1', 'IPv6 unique local'],
  ['fe80::1', 'IPv6 link local'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata — the classic bypass'],
  ['::ffff:10.0.0.1', 'IPv4-mapped private'],
]) {
  check(`${ip} (${why}) is private`, ipIsPrivate(ip) === true);
}

console.log('\n-- addresses that must stay reachable');
for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
  check(`${ip} is public`, ipIsPrivate(ip) === false);
}

console.log('\n-- malformed input is refused, not assumed public');
for (const junk of ['', 'not-an-ip', '999.999.999.999', '10', '0x7f000001']) {
  check(`“${junk}” is treated as private`, ipIsPrivate(junk) === true);
}

console.log('\n-- URLs');
const refused = async (url, why) => {
  try {
    await assertFetchableUrl(url);
    check(`${url} is refused (${why})`, false);
  } catch {
    check(`${url} is refused (${why})`, true);
  }
};

await refused('http://example.com/hook', 'plaintext would carry the seller’s secret in the clear');
await refused('https://127.0.0.1/hook', 'loopback');
await refused('https://169.254.169.254/latest/meta-data/', 'cloud metadata');
await refused('https://localhost/hook', 'localhost by name');
await refused('https://something.localhost/hook', 'localhost subdomain');
await refused('https://printer.local/hook', 'mDNS');
await refused('https://db.internal/hook', 'internal TLD');
await refused('file:///etc/passwd', 'not http');
await refused('gopher://evil/', 'not http');
await refused('nonsense', 'not a URL');

try {
  const u = await assertFetchableUrl('https://example.com/webhook/abc');
  check('a normal https webhook is allowed', u.hostname === 'example.com');
} catch (e) {
  check(`a normal https webhook is allowed (${e.message})`, false);
}

console.log(`\n${pass_} passed, ${fail_} failed`);
process.exit(fail_ ? 1 : 0);
