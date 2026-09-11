'use client';

import { useRouter } from 'next/navigation';
import Avatar from './Avatar';
import Copyable from './Copyable';
import Brand from './Brand';

/**
 * One navigation for the whole product.
 *
 * Buying and selling were two dashboards behind a "Switch to…" link, which
 * implied switching identity. They never were two identities: both pages resolve
 * the same Privy embedded wallet, so a seller's payout address and a buyer's
 * treasury are the same account. The split only stopped a seller from browsing
 * the marketplace, and hid the most interesting behaviour in the product, which
 * is a worker's earnings paying for another worker.
 *
 * The two routes still exist. This makes them read as one app: every section is
 * listed everywhere, and picking one that lives on the other route navigates
 * there with the right tab already selected.
 */

export type NavRoute = 'dashboard' | 'seller';

export type NavItem = {
  id: string;
  label: string;
  route: NavRoute;
  /** Starts a labelled group in the sidebar. */
  group?: string;
};

/**
 * One word for the thing being hired: a worker. There used to be two — "agents"
 * for the spend policies a buyer created, "workers" for the things listed on the
 * marketplace — which meant the same sentence read differently depending on which
 * side of the app you were on. A buyer now has one spend policy (it lives on
 * Overview, not in a tab of its own), so the only list left is the workers you
 * have published.
 */
export const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', route: 'dashboard' },
  { id: 'marketplace', label: 'Marketplace', route: 'dashboard' },
  { id: 'workers', label: 'Workers', route: 'seller' },
  { id: 'allowlist', label: 'Allowlist', route: 'dashboard' },
  { id: 'profile', label: 'Profile', route: 'seller' },
];

const shortAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

const href = (route: NavRoute, tab: string) =>
  `${route === 'dashboard' ? '/dashboard' : '/seller'}?tab=${tab}`;

/** Reads `?tab=` once on mount. Avoids useSearchParams so the pages stay static. */
export function tabFromUrl(allowed: string[]): string | null {
  if (typeof window === 'undefined') return null;
  const t = new URLSearchParams(window.location.search).get('tab');
  return t && allowed.includes(t) ? t : null;
}

export default function SideNav({
  route,
  tab,
  onTab,
  name,
  address,
  fallback,
  onSignOut,
}: {
  route: NavRoute;
  tab: string;
  onTab: (tab: string) => void;
  /** Display name shown above sign out. Truncated rather than wrapped. */
  name?: string | null;
  address?: string | null;
  /** Shown when there is no wallet yet, e.g. an email address. */
  fallback?: string | null;
  onSignOut: () => void;
}) {
  const router = useRouter();

  return (
    <aside className="mt-1 flex w-60 shrink-0 flex-col border-r border-hairline bg-panel px-4 py-5">
      <div className="px-2">
        <Brand />
      </div>

      <nav className="mt-6 flex flex-col gap-1">
        {NAV_ITEMS.map((n) => {
          const active = n.route === route && n.id === tab;
          return (
            <div key={`${n.route}-${n.id}`}>
              <button
                onClick={() => (n.route === route ? onTab(n.id) : router.push(href(n.route, n.id)))}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  active ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'
                }`}
              >
                {n.label}
              </button>
            </div>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-hairline pt-4">
        <div className="flex items-center gap-2.5 px-3">
          <Avatar name={name || address || 'S'} size={28} />
          <div className="min-w-0 flex-1">
            {/* truncate, not wrap: a long display name must not push the
                wallet and sign out around. */}
            <div className="truncate text-sm font-medium" title={name ?? undefined}>{name}</div>
            {address ? (
              <Copyable value={address} className="font-mono text-[11px] text-muted hover:text-foreground">{shortAddr(address)}</Copyable>
            ) : (
              <div className="truncate font-mono text-[11px] text-muted">{fallback ?? 'account'}</div>
            )}
          </div>
        </div>
        <button
          onClick={onSignOut}
          className="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:text-red-400"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
