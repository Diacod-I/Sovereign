// app/lib/curation.ts
// Listings this marketplace declines to serve.
//
// `setActive` on AgentRegistry is `onlyOwner(id)`, so a listing whose wallet
// nobody still holds can never be deactivated. Not by us, not by the deployer,
// not by anyone. That is the honest cost of a permanent registry, and pretending
// otherwise would be worse than living with it.
//
// So this is curation, not deletion, and the distinction is worth keeping
// straight in your head and in what the UI says. The entry is still on chain.
// Anyone reading the registry directly still sees it. What this decides is what
// THIS marketplace puts in front of buyers and what it will let an agent spend
// money on, which is a thing a marketplace is entitled to decide.
//
// Enforced in three places because there are three ways in, and a hidden
// listing that an agent can still buy is not hidden:
//   - the marketplace grid, so nobody sees it
//   - /api/agent/call, so nothing can be bought through the account
//   - /api/curation, which sovereign-mcp reads so Claude never offers it
//
// Deliberately an env var rather than a database: the set is small, changes
// rarely, and should be reviewable in a diff rather than editable at runtime by
// whoever holds a token.

const RAW = process.env.NEXT_PUBLIC_HIDDEN_LISTINGS || '';

/** Lowercased ids this deployment will not serve. */
export const HIDDEN_LISTINGS: string[] = RAW.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const hiddenSet = new Set(HIDDEN_LISTINGS);

export const isHidden = (id: string): boolean => hiddenSet.has((id || '').toLowerCase());

/** Convenience for the places that hold a list of listings. */
export function withoutHidden<T extends { id: string }>(listings: T[]): T[] {
  if (hiddenSet.size === 0) return listings;
  return listings.filter((l) => !isHidden(l.id));
}
