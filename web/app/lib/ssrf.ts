// app/lib/ssrf.ts
// Refusing to fetch private address space.
//
// Two routes now take a URL from a stranger and fetch it from inside our own
// infrastructure: the listing probe, and the hosted worker proxy. Either one is
// an SSRF primitive without this guard — the classic target being cloud metadata
// at 169.254.169.254, which on most providers hands out credentials to anyone
// who can make the server request it.
//
// Server-only: it uses node:dns and node:net.

import dns from 'node:dns/promises';
import net from 'node:net';

/** Local development needs to reach a worker on localhost; production must not. */
export const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_PROBE === 'true';

export function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;              // this-network, private, loopback
  if (a === 169 && b === 254) return true;                        // link-local — cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;               // private
  if (a === 192 && b === 168) return true;                        // private
  if (a === 192 && b === 0) return true;                          // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;           // benchmarking
  if (a >= 224) return true;                                      // multicast + reserved
  return false;
}

export function ipIsPrivate(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4IsPrivate(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped (::ffff:10.0.0.1) inherits the v4 rules.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4IsPrivate(mapped[1]);
    if (/^f[cd]/.test(lower)) return true;                        // unique local
    if (/^fe[89ab]/.test(lower)) return true;                     // link local
    return false;
  }
  return true;
}

/** Resolves the host and rejects if ANY answer lands in private space. */
export async function assertPublicHost(hostname: string): Promise<string> {
  if (net.isIP(hostname)) {
    if (ipIsPrivate(hostname)) throw new Error(`${hostname} is a private address`);
    return hostname;
  }
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error(`${hostname} resolves to this machine`);
  }
  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`DNS lookup failed for ${hostname}`);
  }
  if (!answers.length) throw new Error(`${hostname} does not resolve`);
  // Check every answer — a host with one public and one private record is an attack.
  for (const a of answers) {
    if (ipIsPrivate(a.address)) throw new Error(`${hostname} resolves to private address ${a.address}`);
  }
  return answers[0].address;
}

/**
 * Parses and vets a URL supplied by a user before we fetch it.
 *
 * https only: an upstream reached over plaintext would carry the seller's own
 * auth header in the clear, and we are the ones sending it.
 */
export async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`“${raw}” is not a URL.`);
  }
  if (url.protocol !== 'https:' && !(ALLOW_PRIVATE && url.protocol === 'http:')) {
    throw new Error(`Endpoint must use https:// (got ${url.protocol}//).`);
  }
  if (!ALLOW_PRIVATE) await assertPublicHost(url.hostname);
  return url;
}
