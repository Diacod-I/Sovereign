'use client';

import WorldVerify from './WorldVerify';
import { worldStatus, type SellerVerification } from '../lib/world';

/**
 * Asked for at the point it matters, not at signup.
 *
 * Everything a person does alone — browsing, funding a treasury, setting spend
 * limits — needs no proof of anything. The two things that write into other
 * people's view of the marketplace do: publishing a worker, and grading one.
 * Both are exactly what a Sybil would want to do at scale, and neither is
 * something a first-time visitor hits by accident.
 *
 * Putting the check here rather than on the front door also means the product
 * can be shown to someone without World App: they see the whole marketplace and
 * stop at the one door that should be locked.
 */
export default function VerifyGate({
  wallet,
  action,
  reason,
  onVerified,
  onClose,
}: {
  wallet: string | null;
  /** Short verb phrase, e.g. "list a worker". Completes "Before you can …". */
  action: string;
  /** Why this particular action needs it — the honest answer, in one line. */
  reason: string;
  onVerified: (v: SellerVerification) => void;
  onClose: () => void;
}) {
  const status = worldStatus();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-6 py-10 sm:items-center"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[calc(100dvh-5rem)] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-hairline bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <h2 className="text-lg font-semibold tracking-tight">Before you can {action}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{reason}</p>

        <div className="mt-5 rounded-lg border border-hairline bg-background px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-muted">What this does</div>
          <ul className="mt-1.5 flex flex-col gap-1 text-[11px] leading-relaxed text-muted">
            <li>World checks you are one real person, once.</li>
            <li>The result is recorded on Arc, so buyers can see it on your profile.</li>
            <li>It costs one transaction in gas, and never has to be done again.</li>
          </ul>
        </div>

        <div className="mt-4">
          <WorldVerify wallet={wallet} onVerified={onVerified} />
        </div>

        {status.mode === 'live' && (
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Your World ID is not linked to your wallet publicly. What goes on-chain is a
            one-way pseudonym for this app, which is what makes one-human-one-account
            checkable without identifying you.
          </p>
        )}

        <button
          onClick={onClose}
          className="mt-4 w-full rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted transition-colors hover:text-foreground"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
