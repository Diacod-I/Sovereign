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

/**
 * `img` takes a .gif or a .mp4/.webm indifferently; the carousel chooses <img>
 * or <video> from the extension. Prefer video: the same clip at the same size is
 * roughly thirty times smaller as H.264 than as a GIF, and a 30MB GIF is a card
 * that stays blank for the first several seconds of every visit.
 */
const FEATURES = [
  { n: '01', t: 'Set the rules once', d: 'Give each agent a budget, an allowlist, and an approval threshold.', img: '/hero1.mp4' },
  { n: '02', t: 'Agents pay on their own', d: 'They find services and pay per use in USDC — always within your limits.', img: '/features/pay.gif' },
  { n: '03', t: 'Big spends wait for you', d: 'Anything over the line pauses for a one-tap human approval.', img: '/features/approve.gif' },
  { n: '04', t: 'Everything is on record', d: 'Reputation and audit live on-chain, not in a black box.', img: '/features/audit.gif' },
];

const carousel_items = FEATURES.map((f) => ({ image: f.img, alt: f.t }));

/**
 * Card size for the "how it works" carousel.
 *
 * Exactly half of the 1280x720 source GIFs: the aspect ratio matches, so the
 * card's `object-fit: cover` has nothing to crop off the sides, and the halving
 * puts a source pixel on a whole device pixel at 2x. The carousel scales this
 * down to fit its column, so treat it as an upper bound rather than the rendered
 * size.
 */
const CARD_W = 640;
const CARD_H = 360;

/**
 * How long each card holds before autoplay moves on.
 *
 * Long enough that the carousel reads as "showing you this" rather than as a
 * slideshow you are chasing: a clip gets several passes, and anyone reading the
 * feature text beside it is not interrupted. Picking a card restarts this, and
 * hovering pauses it, so nobody is ever hurried off something they chose.
 */
const SLOT_MS = 60000;

export default function Home() {
  const { ready, authenticated, login } = usePrivy();
  const router = useRouter();
  const [active, setActive] = useState(0);
  const carouselRef = useRef<any>(null);

  // Whether a login the user just started should route onwards. It stays false on
  // a plain page load, which is what keeps an already-signed-in visitor on the
  // landing page instead of being bounced to /dashboard the moment Privy hydrates.
  const [pending, setPending] = useState(false);

  // One destination now. There is no separate seller sign-up: buying and selling
  // are the same account, and the thing that used to divide them -- the World ID
  // check -- is asked for at the first action that other people can see.
  const go = () => {
    if (authenticated) {
      router.push('/dashboard');
      return;
    }
    setPending(true);
    login();
  };

  // Route only once the login the user actually initiated succeeds.
  useEffect(() => {
    if (!ready || !authenticated || !pending) return;
    setPending(false);
    router.replace('/dashboard');
  }, [ready, authenticated, pending, router]);

  return (
    <>
      <div aria-hidden />

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <Brand />
        <div className="flex items-center gap-5">
          <a href="#how" className="text-sm text-muted transition-colors hover:text-foreground">How it works</a>
          <button onClick={go} className="text-sm text-muted transition-colors hover:text-foreground">
            {authenticated ? 'Dashboard' : 'Sign in'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="pt-20 pb-24 sm:pt-28 flex flex-col md:flex-row md:items-center gap-12 w-full">

          {/* Left: text */}
          <div className="flex-1 w-full">
            <h1 className="text-xl font-semibold leading-[1.05] tracking-tight sm:text-4xl">
              A freelance marketplace of agents, for your agent.
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-muted sm:text-lg">
              Your agent searches for a specialist, reads its track record, hires it,
              and pays per call in USDC. You set the budget and grade the work. Every
              hire leaves a receipt on chain, so the next buyer sees what happened.
            </p>
            {/* One command, and it is the whole setup: it writes the skill and
                the MCP registration, then opens a browser to pair this project
                with an account. Someone who has never used Sovereign gets an
                account and a wallet in that same visit, which is what lets the
                hero promise one line without an asterisk.

                `npm i sovereign-mcp` used to sit here and did nothing on its
                own: installing the package neither registers the server nor
                writes the skill. */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Copyable
                value="npx sovereign-mcp@latest link"
                copiedLabel="copied, paste it in your project"
                className="rounded-lg border border-hairline bg-panel px-3 py-2 font-mono text-xs text-muted transition-colors hover:text-foreground"
              >
                <span className="text-accent">$</span>&nbsp;npx sovereign-mcp@latest link
              </Copyable>
              <a href="https://www.npmjs.com/package/sovereign-mcp" target="_blank" rel="noreferrer" className="text-xs text-muted underline underline-offset-2 hover:text-foreground">View on npm ↗</a>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Run it in any project. It sets up Claude Code and links your wallet, and
              makes you an account if you do not have one. Add{' '}
              <span className="font-mono text-foreground">--spend</span> to let Claude pay
              on its own, inside limits you set.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-5">
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
      </main>

      {/* How it works — carousel left (bigger), features synced on the right.
          This section breaks out of the page's max-w-5xl on its own: the cards
          are 1280x720 screen recordings, and at the body width they render
          small enough that you cannot read the UI inside them. */}
      <section id="how" className="border-t border-hairline py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 lg:grid-cols-[7fr_4fr]">

          {/* Left: carousel */}
          <div className="relative h-[300px] w-full sm:h-[460px] lg:h-[560px]">
            <DepthCarousel
              ref={carouselRef}
              items={carousel_items}
              showControls={false}
              showIndicators={false}
              onChange={(i: number) => setActive(i)}
              depth={240}
              spread={48}
              tilt={18}
              tiltDirection="right"
              perspective={1500}
              visibleCards={3}
              falloff={0.18}
              blur={5}
              autoplay
              loop
              cardWidth={CARD_W}
              cardHeight={CARD_H}
              radius={18}
              tint="#05060a"
              duration={700}
              ease="power3.out"
              autoplayDelay={SLOT_MS}
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
