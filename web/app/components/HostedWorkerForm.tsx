'use client';

import { useState } from 'react';
import Copyable from './Copyable';
import { useHostedWorkers } from '../lib/useHostedWorker';
import { slugForWorker, DEFAULT_TIMEOUT_SECONDS } from '../lib/hosted';

/**
 * The no-code on-ramp.
 *
 * Listing a worker used to require an Express server, Circle's Gateway
 * middleware, a Circle API key and a public URL — four developer tasks, and the
 * README's answer to the last one was a tunnel that dies when the laptop closes.
 * Anybody who could do all four did not need a marketplace to find buyers.
 *
 * So the seller brings the one thing only they have: a webhook from whatever
 * they already built in n8n, Dify, Flowise, an Agent Builder workflow, a Zap.
 * Sovereign supplies the rest. What they get back is an https URL that speaks
 * x402 and is theirs to list.
 */

const TOOLS = [
  { name: 'n8n', hint: 'Webhook node → Production URL' },
  { name: 'Dify', hint: 'Publish → API → workflow run endpoint' },
  { name: 'Flowise', hint: 'API Endpoint on the chatflow' },
  { name: 'Make / Zapier', hint: 'Webhooks module → custom webhook URL' },
  { name: 'Relevance AI', hint: 'Tool → Deploy → API' },
];

export default function HostedWorkerForm({
  walletAddress,
  name,
  price,
  payTo,
  onHosted,
}: {
  walletAddress: string | null;
  /** The worker's display name, used to seed the slug. */
  name: string;
  price: string;
  payTo: string;
  /** Called with the hosted URL once it exists, to fill the endpoint field. */
  onHosted: (url: string, slug: string) => void;
}) {
  const { save } = useHostedWorkers(walletAddress);

  const [upstreamUrl, setUpstreamUrl] = useState('');
  const [authHeaderName, setAuthHeaderName] = useState('');
  const [authSecret, setAuthSecret] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TIMEOUT_SECONDS));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string; slug: string } | null>(null);
  const [durable, setDurable] = useState(true);

  const ready = !!upstreamUrl.trim() && !!name.trim() && !!price.trim() && !busy;

  const create = async () => {
    if (!ready) return;
    setErr(null);
    setBusy(true);
    try {
      const slug = slugForWorker(name);
      const worker = await save({
        slug,
        upstreamUrl: upstreamUrl.trim(),
        price: price.trim(),
        payTo: payTo.trim() || walletAddress || '',
        authHeaderName: authHeaderName.trim() || undefined,
        authSecret: authSecret.trim() || undefined,
        timeoutSeconds: Number(timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS,
      });
      setCreated({ url: worker.url, slug: worker.slug });
      setDurable((worker as unknown as { storage?: { durable: boolean } }).storage?.durable ?? true);
      onHosted(worker.url, worker.slug);
      // The secret is in our store now; keeping a copy in a React state field
      // that survives in the page is pointless risk.
      setAuthSecret('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the hosted endpoint.');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
        <div className="text-[10px] uppercase tracking-wider text-accent">Your endpoint is live</div>
        <Copyable value={created.url} className="mt-1 block break-all font-mono text-[11px] text-foreground hover:text-accent">
          {created.url}
        </Copyable>
        <p className="mt-2 text-[10px] leading-relaxed text-muted">
          It answers unpaid calls with a 402 quoting your price and payout address, takes
          the payment, then calls your tool. Run the check below, then list it.
        </p>
        {!durable && (
          <p className="mt-2 text-[10px] leading-relaxed text-amber-400">
            The server has no durable store configured, so this endpoint will stop existing
            the next time it restarts. Set UPSTASH_REDIS_REST_URL and _TOKEN before listing
            it on-chain.
          </p>
        )}
        <button
          type="button"
          onClick={() => { setCreated(null); setUpstreamUrl(''); }}
          className="mt-2 text-[10px] text-muted underline underline-offset-2 hover:text-foreground"
        >
          Point it somewhere else
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm">
        <span className="text-muted">Your tool&apos;s webhook URL</span>
        <input
          value={upstreamUrl}
          onChange={(e) => { setUpstreamUrl(e.target.value); setErr(null); }}
          placeholder="https://your-n8n.app/webhook/abc123"
          className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
        <span className="mt-1.5 block text-[10px] leading-relaxed text-muted">
          We POST <span className="font-mono">{'{"input": …}'}</span> here and return whatever
          comes back. Where to find it:{' '}
          {TOOLS.map((t, i) => (
            <span key={t.name}>
              {i > 0 && ' · '}
              <span className="text-foreground">{t.name}</span> {t.hint}
            </span>
          ))}
        </span>
      </label>

      <details className="rounded-lg border border-hairline bg-background px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-muted hover:text-foreground">
          Does your webhook need an API key?
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-[11px]">
            <span className="text-muted">Header name</span>
            <input
              value={authHeaderName}
              onChange={(e) => setAuthHeaderName(e.target.value)}
              placeholder="X-Api-Key"
              className="mt-1 w-full rounded-lg border border-hairline bg-panel px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
          </label>
          <label className="text-[11px]">
            <span className="text-muted">Value</span>
            <input
              type="password"
              value={authSecret}
              onChange={(e) => setAuthSecret(e.target.value)}
              placeholder="sk-…"
              className="mt-1 w-full rounded-lg border border-hairline bg-panel px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
          </label>
          <p className="text-[10px] leading-relaxed text-muted">
            Encrypted before it is stored and attached only to calls we make to your URL.
            It is never sent to a browser, including yours — after saving, this field
            shows nothing rather than showing you a value we could be lying about.
          </p>
          <label className="text-[11px]">
            <span className="text-muted">Give up after (seconds)</span>
            <input
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              inputMode="numeric"
              className="mt-1 w-24 rounded-lg border border-hairline bg-panel px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
            <span className="mt-1 block text-[10px] leading-relaxed text-muted">
              A buyer is charged before your tool runs, so a slow worker costs them money
              and costs you a not-delivered review. Keep this under what your tool
              actually takes.
            </span>
          </label>
        </div>
      </details>

      {err && <div className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

      <button
        type="button"
        disabled={!ready}
        onClick={create}
        className="rounded-lg border border-hairline px-3 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-40"
      >
        {busy ? 'Creating…' : 'Create my endpoint'}
      </button>
      <p className="text-[10px] leading-relaxed text-muted">
        You will be asked to sign a message. That is what proves this wallet is the one
        putting a URL behind your payout address — no gas, no transaction.
      </p>
    </div>
  );
}
