'use client'

import { useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';

// Components
import DepthCarousel from './components/DepthCarousel';
import Brand from './components/Brand';
import Copyable from './components/Copyable';
// PixelBlast is WebGL — load client-only so it mounts into a sized container (no blank SSR canvas)
const PixelBlast = dynamic(() => import('./components/PixelBlast'), { ssr: false }) as any;

const FEATURES = [
  { n: '01', t: 'Set the rules once', d: 'Give each agent a budget, an allowlist, and an approval threshold.', img: '/features/rules.gif' },
  { n: '02', t: 'Agents pay on their own', d: 'They find services and pay per use in USDC — always within your limits.', img: '/features/pay.gif' },
  { n: '03', t: 'Big spends wait for you', d: 'Anything over the line pauses for a one-tap human approval.', img: '/features/approve.gif' },
  { n: '04', t: 'Everything is on record', d: 'Reputation and audit live on-chain, not in a black box.', img: '/features/audit.gif' },
];

const carousel_items = FEATURES.map((f) => ({ image: f.img, alt: f.t }));

export default function Home() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  const [active, setActive] = useState(0);
  const carouselRef = useRef<any>(null);

  const [intent, setIntent] = useState<'buyer' | 'seller'>('buyer');

  const go = (dest: 'buyer' | 'seller' = 'buyer') => {
    setIntent(dest);
    if (authenticated) router.push(dest === 'seller' ? '/seller' : '/dashboard');
    else login();
  };

  // On successful login, route by the chosen intent.
  useEffect(() => {
    if (ready && authenticated) router.replace(intent === 'seller' ? '/seller' : '/dashboard');
  }, [ready, authenticated, intent, router]);

  return (
    <>
      <div aria-hidden />

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Brand />
        <div className="flex items-center gap-5">
          <button onClick={() => go('seller')} className="text-sm text-muted transition-colors hover:text-foreground">Become a seller</button>
          <button onClick={() => go('buyer')} className="text-sm text-muted transition-colors hover:text-foreground">
            {authenticated ? 'Dashboard' : 'Sign in'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-20 pb-24 sm:pt-28 flex flex-col md:flex-row md:items-center gap-12 w-full">

          {/* Left: text */}
          <div className="flex-1 w-full">
            <h1 className="text-xl font-semibold leading-[1.05] tracking-tight sm:text-4xl">
              Agents pay for you,<br/> you control the action.
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-muted sm:text-lg">
              Sovereign gives every AI agent a wallet with rules. With budgets, allowlists, approvals, it
              transacts on its own without going off the rails.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Copyable
                value="npm i sovereign-mcp"
                copiedLabel="copied — npm i sovereign-mcp"
                className="rounded-lg border border-hairline bg-panel px-3 py-2 font-mono text-xs text-muted transition-colors hover:text-foreground"
              >
                <span className="text-accent">$</span>&nbsp;npm i sovereign-mcp
              </Copyable>
              <a href="https://www.npmjs.com/package/sovereign-mcp" target="_blank" rel="noreferrer" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">View on npm ↗</a>
            </div>
            <div className="mt-9 flex flex-wrap items-center gap-5">
              <button
                onClick={() => go('buyer')}
                disabled={!ready}
                className="rounded-lg bg-[var(--btn)] px-5 py-3 text-sm font-medium text-[var(--btn-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {authenticated ? 'Enter dashboard' : 'Get started'}
              </button>
              <a href="#how" className="text-sm text-muted transition-colors hover:text-foreground">
                How it works
              </a>
            </div>
          </div>

          {/* Right: PixelBlast in a card (client-only) */}
          <div className="flex-1 w-full">
            <div className="relative h-[300px] w-full overflow-hidden rounded-2xl border border-hairline bg-[#0b0b0b] sm:h-[440px]">
              <PixelBlast
                variant="diamond"
                pixelSize={6}
                color="#2FFF00"
                patternScale={3}
                patternDensity={1.1}
                enableRipples
                rippleSpeed={0.35}
                rippleThickness={0.1}
                rippleIntensityScale={1.1}
                speed={0.6}
                edgeFade={0.35}
                transparent
              />
            </div>
          </div>
        </section>

        {/* How it works — carousel left (bigger), features synced on the right */}
        <section id="how" className="border-t border-hairline py-20">
          <div className="grid items-center gap-10 lg:grid-cols-[3fr_2fr]">

            {/* Left: carousel */}
            <div className="relative h-[420px] w-full sm:h-[520px]">
              <DepthCarousel
                ref={carouselRef}
                items={carousel_items}
                showControls={false}
                showIndicators={false}
                onChange={(i: number) => setActive(i)}
                depth={240}
                spread={80}
                tilt={18}
                tiltDirection="right"
                perspective={1500}
                visibleCards={3}
                falloff={0.18}
                blur={5}
                autoplay
                loop
                cardWidth={460}
                cardHeight={300}
                radius={18}
                tint="#05060a"
                duration={700}
                ease="power3.out"
                autoplayDelay={3600}
              />
            </div>

            {/* Right: feature list synced to the active card */}
            <div className="flex flex-col gap-1.5">
              {FEATURES.map((f, i) => {
                const on = i === active;
                return (
                  <button
                    key={f.n}
                    onClick={() => carouselRef.current?.setFocus(i)}
                    aria-current={on}
                    className={`flex gap-4 rounded-xl border px-5 py-4 text-left transition-colors ${on ? 'border-hairline bg-panel' : 'border-transparent hover:bg-panel'}`}
                  >
                    <span className={`pt-0.5 font-mono text-xs ${on ? 'text-accent' : 'text-muted'}`}>{f.n}</span>
                    <div>
                      <h3 className={`text-[15px] font-semibold tracking-tight ${on ? 'text-foreground' : 'text-muted'}`}>{f.t}</h3>
                      <p className={`mt-1.5 text-sm leading-relaxed text-muted ${on ? 'opacity-100' : 'opacity-60'}`}>{f.d}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto max-w-5xl px-6 pb-10">
        <div className="flex flex-col gap-3 border-t border-hairline pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Sovereign · built for ETHOnline 2026</span>
          <span>
            Auth by Privy · Type set in Inter · Visuals via{' '}
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
