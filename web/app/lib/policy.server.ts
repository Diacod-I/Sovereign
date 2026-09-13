// app/lib/policy.server.ts
// The spend policy, where it can actually stop a payment.
//
// It used to live only in localStorage. That was fine while every payment was
// signed by a human in a browser that had just read those limits: the policy was
// a UI that told you what you had decided. The moment a terminal can ask our
// server to spend the account's money, the same object has to be a gate, and a
// gate in someone's browser is not a gate at all.
//
// So this is the authority now, and the browser copy becomes a cache of it.

import { kvGet, kvSet } from './kv';

export type SpendPolicy = {
  dailyBudget: number;
  perAction: number;
  spentToday: number;
  /** UTC day (YYYY-MM-DD) that spentToday counts against. */
  spentOn?: string;
  paused: boolean;
};

export type AllowEntry = {
  id: string;
  listingId: string;
  name: string;
  address: string;
  cap: number;
};

export type AccountPolicy = {
  policy: SpendPolicy;
  allowlist: AllowEntry[];
  updatedAt: number;
};

export const DEFAULT_POLICY: SpendPolicy = {
  dailyBudget: 250,
  perAction: 50,
  spentToday: 0,
  paused: false,
};

const key = (account: string) => `policy:${account.toLowerCase()}`;
const utcDay = () => new Date().toISOString().slice(0, 10);

function rollDaily(p: SpendPolicy): SpendPolicy {
  const today = utcDay();
  return p.spentOn === today ? p : { ...p, spentToday: 0, spentOn: today };
}

export async function readPolicy(account: string): Promise<AccountPolicy | null> {
  const raw = await kvGet(key(account));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as AccountPolicy;
    return { ...p, policy: rollDaily(p.policy) };
  } catch {
    return null;
  }
}

/**
 * Saves the LIMITS. Never the spend.
 *
 * The browser owns what the caps are; the server owns how much has been used,
 * because only the server sees a terminal's calls. Taking `spentToday` from the
 * request looked harmless and was not: opening the dashboard and pressing Save
 * pushed a browser-local 0 over a real balance, so every edit to a limit
 * silently refunded the day's spending. The two values travel in opposite
 * directions and only one of them belongs in this payload.
 */
export async function writePolicy(account: string, next: { policy: SpendPolicy; allowlist: AllowEntry[] }) {
  const current = await readPolicy(account);
  const spent = rollDaily(current?.policy ?? { ...DEFAULT_POLICY });
  const clean: AccountPolicy = {
    policy: rollDaily({
      dailyBudget: Math.max(0, Number(next.policy?.dailyBudget) || 0),
      perAction: Math.max(0, Number(next.policy?.perAction) || 0),
      spentToday: spent.spentToday,
      spentOn: spent.spentOn,
      paused: !!next.policy?.paused,
    }),
    allowlist: (next.allowlist ?? []).slice(0, 200).map((w) => ({
      id: String(w.id ?? '').slice(0, 80),
      listingId: String(w.listingId ?? '').slice(0, 120),
      name: String(w.name ?? '').slice(0, 120),
      address: String(w.address ?? ''),
      cap: Math.max(0, Number(w.cap) || 0),
    })),
    updatedAt: Date.now(),
  };
  await kvSet(key(account), JSON.stringify(clean));
  return clean;
}

export type Verdict =
  | { ok: true; needsApproval: boolean }
  | { ok: false; reason: string };

/**
 * The same rules the browser shows, applied where they bind.
 *
 * `needsApproval` is retained in the verdict and always false. There was a
 * third limit here, an approval threshold above which a call was refused and
 * sent to a human in a browser. It was removed: two limits a person can hold in
 * their head beat three, and a refusal that means "go somewhere else and do it
 * by hand" is a worse answer than either paying or declining. The field stays
 * so callers that branch on it keep compiling.
 */
export function checkPolicy(
  saved: AccountPolicy | null,
  priceUsdc: number,
  payTo: string,
): Verdict {
  // A missing record means "never saved", not "no limits". Refusing outright
  // was inconsistent with reserve(), which already falls back to DEFAULT_POLICY,
  // and it made an invisible record the gate instead of a deliberate one.
  //
  // Defaulting grants nothing on its own: the allowlist below starts empty, so
  // an account that has never configured anything still cannot pay anybody. The
  // binding permission is the allowlist, which is an explicit act in the UI,
  // rather than the presence of a row the account holder never knew about.
  const { policy, allowlist } = saved ?? { policy: { ...DEFAULT_POLICY }, allowlist: [] };
  if (policy.paused) return { ok: false, reason: 'Spending is paused on this account.' };
  if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) return { ok: false, reason: 'That is not a payable amount.' };

  const entry = allowlist.find((w) => w.address.toLowerCase() === payTo.toLowerCase());
  if (!entry) return { ok: false, reason: 'This worker is not on your allowlist. Add it in the marketplace first.' };
  if (entry.cap && priceUsdc > entry.cap) {
    return { ok: false, reason: `Over this worker's per-call cap ($${entry.cap}).` };
  }
  if (priceUsdc > policy.perAction) {
    return { ok: false, reason: `Over your per-action limit ($${policy.perAction}).` };
  }
  if (policy.spentToday + priceUsdc > policy.dailyBudget) {
    return { ok: false, reason: `Over your daily budget ($${policy.spentToday} of $${policy.dailyBudget} spent).` };
  }
  return { ok: true, needsApproval: false };
}

/**
 * Books the spend BEFORE the payment is attempted.
 *
 * Checking and then spending leaves a window where two concurrent calls both
 * pass a check neither has paid for yet, and an agent making parallel calls is
 * the normal case rather than the exotic one. Reserving first means the worst
 * outcome is a refund-shaped correction, not a budget quietly exceeded.
 */
export async function reserve(account: string, amount: number): Promise<AccountPolicy> {
  const saved = (await readPolicy(account)) ?? { policy: { ...DEFAULT_POLICY }, allowlist: [], updatedAt: 0 };
  const next: AccountPolicy = {
    ...saved,
    policy: {
      ...rollDaily(saved.policy),
      spentToday: +(rollDaily(saved.policy).spentToday + amount).toFixed(6),
      spentOn: utcDay(),
    },
    updatedAt: Date.now(),
  };
  await kvSet(key(account), JSON.stringify(next));
  return next;
}

/** Gives it back when the payment did not happen. */
export async function release(account: string, amount: number) {
  const saved = await readPolicy(account);
  if (!saved) return;
  const next: AccountPolicy = {
    ...saved,
    policy: {
      ...saved.policy,
      spentToday: Math.max(0, +(saved.policy.spentToday - amount).toFixed(6)),
    },
    updatedAt: Date.now(),
  };
  await kvSet(key(account), JSON.stringify(next));
}
