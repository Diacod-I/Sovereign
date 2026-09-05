'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Dashboard() {
  const { ready, authenticated, user, logout } = usePrivy();
  const router = useRouter();

  useEffect(() => {
    if (ready && !authenticated) router.replace('/');
  }, [ready, authenticated, router]);

  if (!ready || !authenticated) return null;

  return (
    <>
      <div className="bg-canvas" aria-hidden />
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          Sovereign
        </div>
        <button onClick={logout} className="text-sm text-muted transition-colors hover:text-foreground">
          Sign out
        </button>
      </header>
      <main className="mx-auto max-w-5xl px-6 pt-24">
        <h1 className="text-3xl font-semibold tracking-tight">You are in.</h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
          Signed in as{' '}
          <span className="font-mono text-foreground">
            {user?.email?.address ?? user?.wallet?.address ?? 'your account'}
          </span>
          . The dashboard lives here — agents, policies, and the marketplace come next.
        </p>
      </main>
    </>
  );
}
