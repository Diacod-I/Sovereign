'use client';

import { useEffect, useState } from 'react';
import { useHostedWorkers } from '../lib/useHostedWorker';
import { MAX_TEST_CASES, type TestCase } from '../lib/hosted';
import { MET_COLOR, MET_LABEL } from '../lib/reputation';

/**
 * The part of "teach and train it" that a seller can actually act on.
 *
 * Nobody selling five-cent calls should be fine-tuning weights, and what people
 * mean by "train" is usually narrower than they realise: make it good at my
 * thing, and let me tell whether my last change helped. The first part is a
 * prompt and some documents, which lives in whatever tool they already use. The
 * second part is this, and almost nothing ships it.
 *
 * The grading scale is deliberately the same one buyers use on-chain — met,
 * partially met, not met, against an expectation written down first. A seller
 * who runs these before listing is rehearsing the exact judgement that will
 * otherwise be passed on them in public, on their reputation.
 *
 * Runs skip the payment wall, because it is the seller's own worker and they
 * have proved the wallet. They do not skip the upstream: their own tool bills
 * them as usual, which is the honest cost of a rehearsal.
 */
export default function TestBench({
  walletAddress,
  slug,
}: {
  walletAddress: string | null;
  slug: string;
}) {
  const { list, saveTests, runTest, gradeTest } = useHostedWorkers(walletAddress);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Loaded when this panel is first rendered, not on page load. Reading the
  // cases needs a signature, and a wallet prompt nobody asked for — fired the
  // moment a seller opens their Workers tab — trains people to click through
  // prompts without reading them.
  useEffect(() => {
    let alive = true;
    list()
      .then((all) => {
        if (!alive) return;
        setCases(all.find((w) => w.slug === slug)?.tests ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : 'Could not load your test cases.');
        setLoading(false);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const update = (id: string, patch: Partial<TestCase>) => {
    setCases((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    setDirty(true);
  };

  const add = () => {
    if (cases.length >= MAX_TEST_CASES) return;
    setCases((list) => [
      ...list,
      { id: `t_${Math.random().toString(36).slice(2, 8)}`, input: '{\n  "address": "0x…"\n}', expectation: '' },
    ]);
    setDirty(true);
  };

  const remove = (id: string) => {
    setCases((list) => list.filter((c) => c.id !== id));
    setDirty(true);
  };

  const persist = async () => {
    setErr(null);
    try {
      setCases(await saveTests(slug, cases));
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
    }
  };

  const run = async (id: string) => {
    setErr(null);
    setBusyId(id);
    try {
      // Saved first: a run grades what is stored server-side, and an unsaved
      // edit would otherwise be tested against the previous version without
      // saying so.
      if (dirty) { setCases(await saveTests(slug, cases)); setDirty(false); }
      const res = await runTest(slug, id);
      setCases(res.tests);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The run failed.');
    } finally {
      setBusyId(null);
    }
  };

  const grade = async (id: string, met: 0 | 1 | 2) => {
    setErr(null);
    try {
      setCases(await gradeTest(slug, id, met));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the verdict.');
    }
  };

  const graded = cases.filter((c) => c.lastMet === 0 || c.lastMet === 1 || c.lastMet === 2);
  const met = graded.filter((c) => c.lastMet === 2).length;

  return (
    <div className="rounded-xl border border-hairline bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Test bench</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            Your own inputs, graded the way buyers will grade them. Private to you.
          </p>
        </div>
        {graded.length > 0 && (
          <span className="font-mono text-[11px] text-muted">
            {met}/{graded.length} met
          </span>
        )}
      </div>

      {loading ? (
        <div className="mt-4 h-16 animate-pulse rounded-lg bg-[#1c1c1c]" />
      ) : cases.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-hairline p-5 text-center">
          <p className="text-[11px] leading-relaxed text-muted">
            Write down two or three things a buyer will actually ask for, and what a good
            answer looks like. Then you can change your prompt and see whether it got
            better instead of guessing.
          </p>
          <button
            onClick={add}
            className="mt-3 rounded-lg border border-hairline px-3 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground"
          >
            Add the first case
          </button>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {cases.map((c) => (
            <li key={c.id} className="rounded-lg border border-hairline bg-background p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-[11px]">
                  <span className="text-muted">Input (JSON)</span>
                  <textarea
                    value={c.input}
                    onChange={(e) => update(c.id, { input: e.target.value })}
                    rows={3}
                    className="mt-1 w-full resize-none rounded-lg border border-hairline bg-panel px-2.5 py-1.5 font-mono text-[10px] outline-none focus:border-accent"
                  />
                </label>
                <label className="text-[11px]">
                  <span className="text-muted">What a good answer looks like</span>
                  <textarea
                    value={c.expectation}
                    onChange={(e) => update(c.id, { expectation: e.target.value })}
                    rows={3}
                    placeholder="a risk score plus the sources it checked"
                    className="mt-1 w-full resize-none rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-[11px] outline-none focus:border-accent"
                  />
                </label>
              </div>

              {(c.lastOutput || c.lastError) && (
                <div className="mt-2 rounded-lg border border-hairline bg-panel px-2.5 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {c.lastError ? 'Failed' : 'Returned'}
                    </span>
                    {typeof c.lastLatencyMs === 'number' && (
                      <span className="font-mono text-[10px] text-muted">{c.lastLatencyMs}ms</span>
                    )}
                  </div>
                  {c.lastError ? (
                    <p className="mt-1 text-[10px] leading-relaxed text-red-400">{c.lastError}</p>
                  ) : (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-muted">
                      {c.lastOutput}
                    </pre>
                  )}
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  disabled={busyId === c.id}
                  onClick={() => run(c.id)}
                  className="rounded-lg border border-hairline px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-foreground disabled:opacity-40"
                >
                  {busyId === c.id ? 'Running…' : 'Run'}
                </button>

                {c.lastOutput && !c.lastError && (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted">Did it meet that?</span>
                    {([2, 1, 0] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => grade(c.id, m)}
                        className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                          c.lastMet === m
                            ? `border-current ${MET_COLOR[m]}`
                            : 'border-hairline text-muted hover:text-foreground'
                        }`}
                      >
                        {MET_LABEL[m]}
                      </button>
                    ))}
                  </span>
                )}

                <button
                  onClick={() => remove(c.id)}
                  className="ml-auto text-[10px] text-muted transition-colors hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {err && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

      {cases.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <button
            disabled={cases.length >= MAX_TEST_CASES}
            onClick={add}
            className="rounded-lg border border-hairline px-3 py-1.5 text-[11px] text-muted transition-colors hover:text-foreground disabled:opacity-40"
          >
            Add a case
          </button>
          {dirty && (
            <button
              onClick={persist}
              className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-black transition-opacity hover:opacity-90"
            >
              Save cases
            </button>
          )}
        </div>
      )}
    </div>
  );
}
