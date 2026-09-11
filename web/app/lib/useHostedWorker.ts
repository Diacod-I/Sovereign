// app/lib/useHostedWorker.ts
// Client side of the hosted worker API: signs each request with the seller's
// wallet and talks to /api/workers.

'use client';

import { useCallback } from 'react';
import { useSignMessage } from '@privy-io/react-auth';
import {
  workerAuthMessage,
  type HostedWorkerPublic,
  type TestCase,
  type WorkerAction,
} from './hosted';

export type HostedWorker = HostedWorkerPublic & { tests: TestCase[]; url: string };

export type SaveInput = {
  slug: string;
  upstreamUrl: string;
  price: string;
  payTo: string;
  authHeaderName?: string;
  authSecret?: string;
  clearSecret?: boolean;
  timeoutSeconds?: number;
};

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
  return data;
}

/**
 * Every call is signed. The seller sees a wallet prompt for each one, which is
 * more friction than a session cookie — and the right trade, because the thing
 * being authorised is "fetch this URL from our servers with my secret attached".
 * That deserves an explicit act, not an ambient one.
 */
export function useHostedWorkers(address: string | null) {
  const { signMessage } = useSignMessage();

  const sign = useCallback(
    async (action: WorkerAction, slug: string, upstreamUrl: string) => {
      if (!address) throw new Error('No wallet');
      const issuedAt = new Date().toISOString();
      const message = workerAuthMessage({ action, slug, owner: address, upstreamUrl, issuedAt });
      const { signature } = await signMessage({ message }, { address });
      return { owner: address, issuedAt, signature };
    },
    [address, signMessage],
  );

  const list = useCallback(async (): Promise<HostedWorker[]> => {
    const auth = await sign('list', '', '');
    const data = await post('/api/workers', { action: 'list', ...auth });
    return data.workers as HostedWorker[];
  }, [sign]);

  const save = useCallback(
    async (input: SaveInput): Promise<HostedWorker> => {
      const auth = await sign('save', input.slug, input.upstreamUrl);
      const data = await post('/api/workers', { action: 'save', ...input, ...auth });
      return data.worker as HostedWorker;
    },
    [sign],
  );

  const saveTests = useCallback(
    async (slug: string, cases: TestCase[]): Promise<TestCase[]> => {
      const auth = await sign('test', slug, '');
      const data = await post('/api/workers/test', { op: 'save', slug, cases, ...auth });
      return data.tests as TestCase[];
    },
    [sign],
  );

  const runTest = useCallback(
    async (slug: string, caseId: string) => {
      const auth = await sign('test', slug, '');
      return post('/api/workers/test', { op: 'run', slug, caseId, ...auth }) as Promise<{
        ok: boolean;
        status: number;
        output: string;
        latencyMs: number;
        error?: string;
        tests: TestCase[];
      }>;
    },
    [sign],
  );

  const gradeTest = useCallback(
    async (slug: string, caseId: string, met: 0 | 1 | 2): Promise<TestCase[]> => {
      const auth = await sign('test', slug, '');
      const data = await post('/api/workers/test', { op: 'grade', slug, caseId, met, ...auth });
      return data.tests as TestCase[];
    },
    [sign],
  );

  return { list, save, saveTests, runTest, gradeTest };
}
