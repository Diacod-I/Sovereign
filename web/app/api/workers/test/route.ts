// web/app/api/workers/test/route.ts
// The seller's private test bench.
//
// "Teach and train" is what a non-developer asks for; what they can actually
// act on is narrower and more useful. Fine-tuning weights is the wrong tool for
// something charging five cents a call. What makes a worker good is a sharp
// prompt, the right documents behind it, a few worked examples — and, the piece
// nobody builds, a way to tell whether the last edit helped.
//
// So this runs the seller's own saved inputs against their worker with the
// payment wall bypassed, and lets them grade the output on exactly the scale
// buyers grade with on-chain. A private rehearsal of the public judgement.
//
// Bypassing payment is safe only because it is bypassing the seller's own
// paywall, on the seller's own worker, proved by a signature from the wallet
// that owns it. The upstream is still called for real, so the seller pays
// whatever their own tool charges them — which is the honest cost of a rehearsal.

import { authorizeOwnerOf, putWorker, unseal } from '../../../lib/hosted.server';
import { assertFetchableUrl } from '../../../lib/ssrf';
import { DEFAULT_TIMEOUT_SECONDS, MAX_TEST_CASES, type TestCase } from '../../../lib/hosted';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_OUTPUT_CHARS = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Body = {
  owner?: string;
  slug?: string;
  issuedAt?: string;
  signature?: string;
  /** 'run' calls the upstream; 'save' stores the cases; 'grade' records a verdict. */
  op?: 'run' | 'save' | 'grade';
  caseId?: string;
  cases?: TestCase[];
  met?: 0 | 1 | 2;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const slug = (body.slug || '').trim();
  const auth = await authorizeOwnerOf(slug, { ...body, action: 'test', upstreamUrl: '' });
  if (!auth.ok) return json({ error: auth.detail }, auth.status);
  const worker = auth.worker;

  // ---- save the case list ---------------------------------------------------
  if (body.op === 'save') {
    const cases = (body.cases ?? []).slice(0, MAX_TEST_CASES).map((c) => ({
      id: String(c.id || '').slice(0, 40) || `t_${Math.random().toString(36).slice(2, 8)}`,
      input: String(c.input ?? '').slice(0, 8000),
      expectation: String(c.expectation ?? '').slice(0, 1000),
      lastMet: c.lastMet ?? null,
      lastOutput: c.lastOutput?.slice(0, MAX_OUTPUT_CHARS),
      lastLatencyMs: c.lastLatencyMs,
      lastRunAt: c.lastRunAt,
      lastError: c.lastError,
    }));
    await putWorker({ ...worker, tests: cases, updatedAt: Date.now() });
    return json({ ok: true, tests: cases });
  }

  // ---- record a verdict -----------------------------------------------------
  if (body.op === 'grade') {
    const met = body.met;
    if (met !== 0 && met !== 1 && met !== 2) return json({ error: 'met must be 0, 1 or 2.' }, 400);
    const tests = worker.tests.map((t) => (t.id === body.caseId ? { ...t, lastMet: met } : t));
    await putWorker({ ...worker, tests, updatedAt: Date.now() });
    return json({ ok: true, tests });
  }

  // ---- run one case ---------------------------------------------------------
  const testCase = worker.tests.find((t) => t.id === body.caseId);
  if (!testCase) return json({ error: 'No such test case.' }, 404);
  if (!worker.upstreamUrl) return json({ error: 'This worker has no upstream to call.' }, 400);

  // The input is stored as text so it round-trips exactly as typed. If it is not
  // valid JSON, say so here rather than sending something the upstream will
  // reject in a way the seller cannot interpret.
  let parsedInput: unknown;
  try {
    parsedInput = testCase.input.trim() ? JSON.parse(testCase.input) : {};
  } catch {
    return json({ error: 'This test input is not valid JSON.' }, 400);
  }

  let url: URL;
  try {
    url = await assertFetchableUrl(worker.upstreamUrl);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'The upstream URL cannot be reached.' }, 400);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Sovereign-Worker-Proxy/1 (test)',
    'x-sovereign-worker': worker.slug,
    // The upstream can tell a rehearsal from a paid call and skip its own
    // metering if it wants to.
    'x-sovereign-test': '1',
  };
  if (worker.authHeaderName && worker.authSecretSealed) {
    try {
      headers[worker.authHeaderName] = unseal(worker.authSecretSealed);
    } catch {
      return json({ error: 'The stored upstream secret could not be decrypted. Re-enter it.' }, 500);
    }
  }

  const started = Date.now();
  let status = 0;
  let output = '';
  let error: string | undefined;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: parsedInput }),
      signal: AbortSignal.timeout((worker.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000),
      redirect: 'error',
      cache: 'no-store',
    });
    status = res.status;
    const text = await res.text();
    output = text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
    if (!res.ok) error = `Upstream returned HTTP ${res.status}.`;
  } catch (e) {
    error =
      e instanceof Error && e.name === 'TimeoutError'
        ? `The upstream did not answer within ${worker.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS}s. Buyers would be charged and get nothing.`
        : e instanceof Error
          ? e.message
          : 'The upstream call failed.';
  }

  const latencyMs = Date.now() - started;
  const tests = worker.tests.map((t) =>
    t.id === testCase.id
      ? { ...t, lastOutput: output, lastLatencyMs: latencyMs, lastRunAt: Date.now(), lastError: error, lastMet: null }
      : t,
  );
  await putWorker({ ...worker, tests, updatedAt: Date.now() });

  return json({ ok: !error, status, output, latencyMs, error, tests });
}
