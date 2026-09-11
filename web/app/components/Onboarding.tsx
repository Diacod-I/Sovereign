'use client';

import { useState } from 'react';
import Brand from './Brand';
import Copyable from './Copyable';
import { useEmbeddedWallet } from '../lib/useEmbeddedWallet';
import { writeProfile } from '../lib/profile';

/**
 * One onboarding, for one kind of account.
 *
 * There used to be two, and the difference between them was the World ID check:
 * sellers had to prove personhood, buyers did not. That was backwards. The thing
 * most worth protecting from a Sybil is the *review* — one person with ten
 * wallets can five-star their own worker into the top of the marketplace — and
 * reviews come from buyers.
 *
 * So verification is no longer a signup wall on one side of a split that no
 * longer exists. It is asked for at the first action that other people can see:
 * listing a worker, or filing a receipt. Until then you can look around, set
 * your limits and fund a treasury without proving anything, which is also what
 * makes the product demonstrable to someone who does not have World App open.
 */
export default function Onboarding({
  logout,
  onDone,
}: {
  logout: () => void;
  onDone: (profile: { name: string; bio: string }) => void;
}) {
  const [name, setName] = useState('');
  const { address: walletAddress } = useEmbeddedWallet();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const profile = { name: trimmed, bio: '' };
    writeProfile(profile);
    onDone(profile);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-panel p-7">
        <Brand />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Name your account</h1>
        <p className="mt-2 text-sm text-muted">
          This is what buyers see on your listings and what your treasury, spend limits
          and workers all live under.
        </p>

        <label className="mt-6 block text-sm">
          <span className="text-muted">Display name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Maya Chen"
            className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2.5 outline-none focus:border-accent"
          />
        </label>

        <div className="mt-3 rounded-lg border border-hairline bg-background px-3 py-2.5 text-sm">
          <div className="text-[11px] uppercase tracking-wider text-muted">Your wallet</div>
          {walletAddress ? (
            <Copyable value={walletAddress} className="mt-0.5 break-all font-mono text-xs hover:text-foreground">
              {walletAddress}
            </Copyable>
          ) : (
            <div className="mt-0.5 font-mono text-xs text-muted">created on continue</div>
          )}
          <div className="mt-1.5 text-[11px] leading-relaxed text-muted">
            It pays for the workers you hire and receives what your own workers earn.
          </div>
        </div>

        <button
          disabled={!name.trim()}
          onClick={submit}
          className="mt-6 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Continue
        </button>

        <p className="mt-3 text-center text-[11px] leading-relaxed text-muted">
          You will be asked to prove you are a unique human with World ID the first
          time you list a worker or review one.
        </p>

        <button onClick={logout} className="mt-3 w-full text-center text-xs text-muted hover:text-foreground">
          Sign out
        </button>
      </div>
    </div>
  );
}
