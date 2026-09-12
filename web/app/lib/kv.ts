// app/lib/kv.ts
// The smallest durable key-value store that works on Vercel.
//
// Two things in this app need to remember something across requests: hosted
// worker configs, and the World ID nullifier replay guard. Both were previously
// a Map in module scope, which on serverless means each instance has its own
// copy and all of them forget on a cold start. For the nullifier guard that was
// a documented weakness; for worker configs it would mean endpoints that stop
// existing at random.
//
// Upstash's REST API is used rather than a Redis client because serverless has
// nowhere to put a connection pool. With no credentials configured this falls
// back to an in-process Map, so `npm run dev` needs no setup — but that fallback
// is per-instance and forgetful, and says so loudly if anything writes to it.

// Two spellings, because there are two ways to provision the same database and
// they disagree about names. Going to upstash.com gives you
// UPSTASH_REDIS_REST_*; provisioning through Vercel's marketplace injects
// KV_REST_API_* for the very same Upstash instance. Accepting both means the
// one-click path works without anyone having to notice, rather than failing as
// "no durable store" while the dashboard plainly shows a database attached.
const URL_ =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  '';
const TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  '';

export const kvConfigured = !!URL_ && !!TOKEN;

/**
 * Whether anything may rely on storage surviving.
 *
 * Features that would strand a user halfway through (pairing a terminal, saving
 * the limits that gate spending) refuse when this is false, rather than
 * appearing to work and forgetting. The escape hatch is for a single long-lived
 * process, where the in-memory map is genuinely durable enough; it is not for
 * serverless, where it is not.
 */
export const storageUsable =
  kvConfigured || process.env.SOVEREIGN_ALLOW_EPHEMERAL_LINKS === 'true';

/**
 * Stashed on globalThis, not in module scope.
 *
 * Next bundles each route separately, so a module-scope Map gives /api/policy
 * and /api/agent/pay their OWN copies inside one process: a policy written by
 * one is invisible to the other, and the failure looks like "no policy is set"
 * rather than like a storage bug. One global makes the fallback at least
 * coherent within a process, which is as far as it can honestly go.
 */
const globalStore = globalThis as unknown as { __sovereignKv?: Map<string, string> };
const memory = (globalStore.__sovereignKv ??= new Map<string, string>());
let warned = false;

function warnOnce() {
  if (warned || kvConfigured) return;
  warned = true;
  console.warn(
    '[kv] UPSTASH_REDIS_REST_URL / _TOKEN are not set — using an in-process Map.\n' +
    '     Fine for one long-lived process. On serverless this loses every hosted\n' +
    '     worker, spend policy and pairing on the next cold start, and is not\n' +
    '     shared between instances.',
  );
}

/**
 * How long to wait on the store before giving up.
 *
 * There was no timeout here, which meant an unreachable Upstash did not fail,
 * it hung -- and every route that touches the store hung with it. A request
 * that never returns is the worst failure to debug, because it produces no
 * error anywhere and looks like the UI being stuck rather than storage being
 * unreachable. Failing at eight seconds turns that into a sentence.
 */
const KV_TIMEOUT_MS = 8000;

async function command(args: (string | number)[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(URL_, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: AbortSignal.timeout(KV_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === 'TimeoutError'
      ? `no response in ${KV_TIMEOUT_MS / 1000}s`
      : e instanceof Error ? e.message : 'unreachable';
    throw new Error(
      `kv ${args[0]} failed: ${why}. Check UPSTASH_REDIS_REST_URL is the https REST URL ` +
      `(not the redis:// connection string) and that the token matches it.`,
    );
  }
  if (!res.ok) throw new Error(`kv ${args[0]} failed: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(`kv ${args[0]} failed: ${json.error}`);
  return json.result ?? null;
}

export async function kvGet(key: string): Promise<string | null> {
  warnOnce();
  if (!kvConfigured) return memory.get(key) ?? null;
  const r = await command(['GET', key]);
  return typeof r === 'string' ? r : null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  warnOnce();
  if (!kvConfigured) { memory.set(key, value); return; }
  await command(['SET', key, value]);
}

export async function kvDel(key: string): Promise<void> {
  warnOnce();
  if (!kvConfigured) { memory.delete(key); return; }
  await command(['DEL', key]);
}

/**
 * Set only if absent. Used where the whole point is that two callers racing for
 * the same key must not both win — a slug claim, or one human claiming one
 * account. A read-then-write would let both through.
 */
export async function kvSetIfAbsent(key: string, value: string): Promise<boolean> {
  warnOnce();
  if (!kvConfigured) {
    if (memory.has(key)) return false;
    memory.set(key, value);
    return true;
  }
  const r = await command(['SET', key, value, 'NX']);
  return r !== null;
}

/** Members of a set — used to list one owner's workers without scanning keys. */
export async function kvSetAdd(key: string, member: string): Promise<void> {
  warnOnce();
  if (!kvConfigured) {
    const cur = memory.get(key);
    const list: string[] = cur ? JSON.parse(cur) : [];
    if (!list.includes(member)) list.push(member);
    memory.set(key, JSON.stringify(list));
    return;
  }
  await command(['SADD', key, member]);
}

export async function kvSetMembers(key: string): Promise<string[]> {
  warnOnce();
  if (!kvConfigured) {
    const cur = memory.get(key);
    return cur ? (JSON.parse(cur) as string[]) : [];
  }
  const r = await command(['SMEMBERS', key]);
  return Array.isArray(r) ? (r as string[]) : [];
}

export async function kvSetRemove(key: string, member: string): Promise<void> {
  warnOnce();
  if (!kvConfigured) {
    const cur = memory.get(key);
    const list: string[] = cur ? JSON.parse(cur) : [];
    memory.set(key, JSON.stringify(list.filter((m) => m !== member)));
    return;
  }
  await command(['SREM', key, member]);
}
