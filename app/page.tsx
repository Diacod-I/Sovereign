'use client';

import Image from 'next/image'
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';

// Images
import logoTransparent from '../public/logo_transparent.png'

const FEATURES = [
  { n: '01', t: 'Set the rules once', d: 'Give each agent a budget, an allowlist, and an approval threshold.' },
  { n: '02', t: 'Agents pay on their own', d: 'They find services and pay per use in USDC — always within your limits.' },
  { n: '03', t: 'Big spends wait for you', d: 'Anything over the line pauses for a one-tap human approval.' },
  { n: '04', t: 'Everything is on record', d: 'Reputation and audit live on-chain, not in a black box.' },
];

export default function Home() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();

  const go = () => {
    if (authenticated) router.push('/dashboard');
    else login();
  };

  return (
    <>
      <div className="bg-canvas" aria-hidden />

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center text-[15px] font-semibold tracking-tight">
          <Image 
            src={logoTransparent}
            alt='Logo with text Sovereign'
            placeholder="blur"
            width={56}
            height={56}/>
            <p className="mt-1">
                Sovereign
            </p>
        </div>
        <button onClick={go} className="text-sm text-muted transition-colors hover:text-foreground">
          {authenticated ? 'Dashboard' : 'Sign in'}
        </button>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-20 pb-24 sm:pt-28">
          <h1 className="mt-6 max-w-2xl text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            With Sovereign,
            <br />
            you keep the controls, agents pay for you.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg">
            Sovereign gives every AI agent a wallet with rules — budgets, allowlists, and approvals — so it
            transacts on its own without going off the rails.
          </p>
          <div className="mt-9 flex items-center gap-5">
            <button
              onClick={go}
              disabled={!ready}
              className="rounded-lg bg-[var(--btn)] px-5 py-3 text-sm font-medium text-[var(--btn-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {authenticated ? 'Enter dashboard' : 'Get started'}
            </button>
            <a href="#how" className="text-sm text-muted transition-colors hover:text-foreground">
              How it works
            </a>
          </div>
        </section>

        <section id="how" className="border-t border-hairline py-16">
          <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <div key={f.n} className="flex gap-4">
                <span className="pt-1 font-mono text-xs text-muted">{f.n}</span>
                <div>
                  <h3 className="text-[15px] font-semibold tracking-tight">{f.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{f.d}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-5xl px-6 pb-10">
        <div className="flex flex-col gap-3 border-t border-hairline pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Sovereign · built for ETHOnline 2026</span>
          <span>
            Auth by Privy · Type set in Inter · Backdrop inspired by{' '}
            <a
              href="https://reactbits.dev"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              reactbits.dev
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}
