'use client'

import { usePrivy } from '@privy-io/react-auth';
import { useRouter } from 'next/navigation';

// Components
import DepthCarousel from './components/DepthCarousel';
import PixelBlast from './components/PixelBlast';

// Images
import Image from 'next/image'
import logoTransparent from '../public/logo_transparent.png'


const carousel_items = [
  { image: 'https://picsum.photos/seed/a/800/1000', alt: 'One' },
  { image: 'https://picsum.photos/seed/b/800/1000', alt: 'Two' },
  { image: 'https://picsum.photos/seed/c/800/1000', alt: 'Three' },
  { image: 'https://picsum.photos/seed/d/800/1000', alt: 'Four' },
  { image: 'https://picsum.photos/seed/e/800/1000', alt: 'Five' }
];

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
      <div aria-hidden />

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center text-[15px] font-semibold tracking-tight">
          <Image
            src={logoTransparent}
            alt='Logo with text Sovereign'
            placeholder="blur"
            width={36}
            height={36} />
          <p className="mt-1 mx-2 text-lg">
            Sovereign
          </p>
        </div>
        <button onClick={go} className="text-sm text-muted transition-colors hover:text-foreground">
          {authenticated ? 'Dashboard' : 'Sign in'}
        </button>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-20 pb-24 sm:pt-28 flex flex-col md:flex-row items-center justify-between gap-12 w-full">

          {/* Left Side */}
          <div className="flex-1 w-full">
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-4xl">
              You keep the controls, agents pay for you.
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-muted sm:text-lg">
              Sovereign gives every AI agent a wallet with rules. With budgets, allowlists, approvals, it
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
          </div>

          {/* Right Side */}
          <div className="flex-1 w-full">
            <div style={{ width: '85%', height: '500px', position: 'relative' }}>
              <PixelBlast
                variant="diamond"
                pixelSize={5}
                color="#2FFF00"
                patternScale={3.5}
                patternDensity={1.7}
                pixelSizeJitter={1.2}
                enableRipples
                rippleSpeed={0.4}
                rippleThickness={0.12}
                rippleIntensityScale={1.5}
                liquid
                liquidStrength={0.12}
                liquidRadius={1.2}
                liquidWobbleSpeed={5}
                speed={2.8}
                edgeFade={0.5}
                transparent
              />
            </div>
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
          <div className="mt-16" style={{ height: '500px', position: 'relative' }}>
            <DepthCarousel
              items={carousel_items}
              depth={220}
              spread={90}
              tilt={22}
              tiltDirection="right"
              perspective={1400}
              visibleCards={4}
              falloff={0.2}
              blur={6}
              autoplay={false}
              loop
              cardWidth={420}
              cardHeight={280}
              radius={18}
              tint="#05060a"
              duration={700}
              ease="power3.out"
              autoplayDelay={3200}
            />
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

