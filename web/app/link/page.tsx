'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePrivy, useSignMessage, useDelegatedActions, useSigners } from '@privy-io/react-auth';
import Brand from '../components/Brand';
import Copyable from '../components/Copyable';
import { useEmbeddedWallet } from '../lib/useEmbeddedWallet';
import { formatCode, linkApprovalMessage, type LinkScope } from '../lib/link';
import { readProfile, writeProfile } from '../lib/profile';

/**
 * Approving a terminal.
 *
 * The code is shown here as well as in the terminal, and the person is asked to
 * check they match before approving. That comparison is the whole security of a
 * device flow: without it, anyone can start a pairing, send you this URL, and
 * have you approve their session onto your account.
 *
 * This page is also the signup. Someone who has never used Sovereign runs the
 * command, lands here, signs in with an email, gets a wallet, and approves in
 * one visit. Sending them away to create an account and back again is how a
 * one-command promise stops being one command.
 */

type Status = {
  code: string;
  scope: LinkScope;
  label: string | null;
  state: 'pending' | 'approved' | 'denied' | 'expired';
};

/** Long enough for a cold serverless start, short enough to fail rather than hang. */
const REQUEST_TIMEOUT_MS = 20000;

/** Long enough to read a consent dialog and decide. */
const DELEGATION_TIMEOUT_MS = 90000;

/**
 * The key quorum our server signs with, from the Privy dashboard.
 *
 * Privy has two generations of this. `delegateWallet` is the older "delegated
 * actions" model, which grants the app blanket permission; `addSigners` is the
 * current one, which attaches a NAMED signer -- our authorization key's quorum
 * -- and optionally a policy that caps what it may do. Newer Privy apps are
 * provisioned only for the second, which is why the first can sit forever with
 * no dialog: there is no legacy delegation for it to ask about.
 *
 * Set this and we use the modern path. Leave it unset and we fall back, so an
 * app configured the old way keeps working.
 */
const PRIVY_SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID || '';

/**
 * True when Privy refused an `addSigners` call because the wallet already
 * carries that signer.
 *
 * This is not a failure. The error describes the exact end state we were
 * trying to reach, so surfacing it strands a correctly configured wallet on
 * the approval page with a message that reads like something broke. Privy
 * phrases it as a duplicate and does not surface a stable error code through
 * the SDK here, so the message is what there is to match on. Anything that
 * does not match still propagates, because a real delegation failure must not
 * be swallowed into a signature the server will later reject.
 */
function isAlreadyAttached(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? '');
  return /duplicate signer|already been added|already a signer|already has/i.test(m);
}

/** Optional Privy signer policy, capping amount and expiry server-side. */
const PRIVY_POLICY_ID = process.env.NEXT_PUBLIC_PRIVY_POLICY_ID || '';

/**
 * Reject a promise that will otherwise never settle.
 *
 * Needed because a wallet SDK call waiting on a prompt is not cancellable and
 * does not time out on its own. The underlying work is not stopped, only
 * stopped being waited on, which is the honest limit of what a caller can do
 * about somebody else's pending dialog.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** What Privy already knows about this wallet, before we ask it to do anything. */
type WalletFacts = { found: boolean; embedded: boolean; delegated: boolean };

/**
 * Read the delegation state off the user rather than inferring it from a call.
 *
 * Two failures look identical from the outside and are fixed differently.
 * Delegating a wallet that is ALREADY delegated has nothing to consent to, so
 * no dialog appears and the promise can sit forever. And delegation only
 * applies to Privy's own embedded wallets, so asking it of an external wallet
 * is a category error rather than a permission the user can grant. Both present
 * as "stuck on granting permission", and neither is worth discovering by
 * waiting ninety seconds.
 */
function walletFacts(
  linkedAccounts: ReadonlyArray<Record<string, unknown>> | undefined,
  address: string,
): WalletFacts {
  const want = address.toLowerCase();
  const hit = (linkedAccounts ?? []).find(
    (a) => a?.type === 'wallet' && String(a?.address ?? '').toLowerCase() === want,
  );
  if (!hit) return { found: false, embedded: false, delegated: false };
  const client = String(hit.walletClientType ?? '');
  return {
    found: true,
    embedded: client === 'privy' || client === 'privy-v2',
    delegated: hit.delegated === true,
  };
}

const post = async (body: unknown) => {
  let res: Response;
  try {
    res = await fetch('/api/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(
      e instanceof Error && e.name === 'TimeoutError'
        ? 'Sovereign did not answer in 20 seconds. Its durable store may be unreachable.'
        : 'Could not reach Sovereign.',
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
  return data;
};

export default function LinkPage() {
  const { ready, authenticated, login, user } = usePrivy();
  const { signMessage } = useSignMessage();
  /**
   * The UI variant, not the headless one.
   *
   * Both have the same signature, and the difference is the whole bug: the
   * headless hook deliberately renders nothing, on the assumption that the app
   * has collected consent itself. This app has not, and it runs with
   * `showWalletUIs: true`, so the headless call sat waiting on a confirmation
   * that nobody was ever going to draw. A promise awaiting a prompt that does
   * not exist does not reject, it simply never settles.
   */
  const { delegateWallet } = useDelegatedActions();
  const { addSigners } = useSigners();
  const { address } = useEmbeddedWallet();

  const [code, setCode] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * Which step we are inside, not merely that we are inside one.
   *
   * Approving is three waits with unrelated failure modes: Privy's delegation
   * consent, a wallet signature, and a request to our own server. One
   * "Approving…" cannot distinguish "a prompt is open behind this window" from
   * "our server is not answering", and those need opposite responses from the
   * person staring at it. Delegation is named first because it runs first and
   * is the one people do not expect.
   */
  const [busy, setBusy] = useState<null | 'delegating' | 'signing' | 'sending'>(null);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);

  // Read once on mount rather than via useSearchParams, so this page stays static.
  useEffect(() => {
    const c = formatCode(new URLSearchParams(window.location.search).get('code') ?? '');
    setCode(c);
    if (!c) return;
    post({ op: 'status', code: c })
      .then((d) => setStatus(d as Status))
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not read that code.'));
  }, []);

  useEffect(() => {
    if (authenticated && !readProfile()) setNeedsName(true);
  }, [authenticated]);

  // Memoised so `approve` can depend on it without being rebuilt every render,
  // and so the notice below and the guard inside the callback can never
  // disagree about what Privy says.
  const facts = useMemo(
    () => (address
      ? walletFacts(user?.linkedAccounts as unknown as ReadonlyArray<Record<string, unknown>> | undefined, address)
      : null),
    [user?.linkedAccounts, address],
  );

  const approve = useCallback(async () => {
    if (!address || !status) return;
    setErr(null);
    setBusy('signing');
    try {
      // A brand-new account has no name yet, and the name is what buyers see on
      // anything this terminal later lists. Ask before granting, not after.
      if (needsName) {
        const trimmed = name.trim();
        if (!trimmed) { setErr('Give your account a name first.'); setBusy(null); return; }
        writeProfile({ name: trimmed, bio: '' });
        setNeedsName(false);
      }
      // Delegation FIRST, approval second. If Privy refuses or the person backs
      // out of its prompt, no token should exist: a `spend` token whose wallet
      // was never delegated is a credential that looks like it can pay and
      // cannot, which surfaces later as an unexplained failure mid-task.
      if (status.scope === 'spend') {
        if (!facts) throw new Error('No wallet resolved yet.');
        if (!facts.found) {
          throw new Error('Privy does not list this wallet on your account, so it cannot be delegated.');
        }
        if (!facts.embedded) {
          throw new Error(
            'That is an external wallet. Delegation only applies to the Privy embedded wallet, ' +
              'which is the one Sovereign signs with.',
          );
        }
        // `delegated` is one boolean and cannot say WHICH signer is attached.
        // On the session-signer path that distinction is the whole question:
        // rotating the authorization key produces a new quorum, and a wallet
        // still carrying the old one reads as delegated while the server holds
        // a key that no longer matches it. Skipping is therefore only safe for
        // legacy delegation, where there is exactly one thing to grant.
        // Re-running addSigners costs a dialog rather than correctness: if the
        // signer is already the current one Privy rejects it as a duplicate,
        // which isAlreadyAttached below reads as success.
        if (facts.delegated && !PRIVY_SIGNER_ID) {
          setBusy('signing');
        } else {
          setBusy('delegating');
        // Bounded, because this waits on a third party's UI and the failure we
        // actually hit was an indefinite one. Long enough for somebody to read
        // a consent dialog and decide; short enough that "stuck" eventually
        // becomes a sentence naming the setting to check.
          try {
            await withTimeout(
              PRIVY_SIGNER_ID
                ? addSigners({
                    address,
                    signers: [
                      PRIVY_POLICY_ID
                        ? { signerId: PRIVY_SIGNER_ID, policyIds: [PRIVY_POLICY_ID] }
                        : { signerId: PRIVY_SIGNER_ID },
                    ],
                  }).then(() => undefined)
                : delegateWallet({ address, chainType: 'ethereum' }),
              DELEGATION_TIMEOUT_MS,
              PRIVY_SIGNER_ID
                ? 'Privy never confirmed the signer. Check that NEXT_PUBLIC_PRIVY_SIGNER_ID is the key ' +
                  'quorum id your authorization key belongs to.'
                : 'Privy never confirmed the delegation, and no signer id is configured. Set ' +
                  'NEXT_PUBLIC_PRIVY_SIGNER_ID to your key quorum id: newer Privy apps do not support ' +
                  'the older delegated-actions flow this fell back to.',
            );
          } catch (e) {
            if (!isAlreadyAttached(e)) throw e;
          }
        }
      }

      const issuedAt = new Date().toISOString();
      const message = linkApprovalMessage({ code: status.code, account: address, scope: status.scope, issuedAt });
      setBusy('signing');
      const { signature } = await signMessage({ message }, { address });
      setBusy('sending');
      await post({ op: 'approve', code: status.code, account: address, scope: status.scope, issuedAt, signature });
      setDone('approved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not approve.');
    } finally {
      setBusy(null);
    }
  }, [address, status, signMessage, delegateWallet, addSigners, needsName, name, facts]);

  const deny = useCallback(async () => {
    if (!status) return;
    try { await post({ op: 'deny', code: status.code }); } catch {}
    setDone('denied');
  }, [status]);

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-panel p-7">
        <Brand />
        {children}
      </div>
    </div>
  );

  if (!code) {
    return shell(
      <>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">No code to approve</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This page finishes a pairing started from a terminal. Run{' '}
          <span className="font-mono text-foreground">npx sovereign-mcp@latest link</span> and it
          will open the right link for you.
        </p>
      </>,
    );
  }

  if (err && !status) {
    return shell(
      <>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">That code did not work</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{err}</p>
      </>,
    );
  }

  if (done === 'approved') {
    return shell(
      <>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Terminal linked</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Go back to your terminal. It has picked this up already.
        </p>
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          You can revoke this at any time from Overview. Revoking takes effect on the
          next call, not the next restart.
        </p>
        <a href="/dashboard" className="mt-6 block w-full rounded-lg bg-accent px-4 py-2.5 text-center text-sm font-medium text-black">
          Open Sovereign
        </a>
      </>,
    );
  }

  if (done === 'denied') {
    return shell(
      <>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Not linked</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Nothing was granted. If you did not start this, it is worth knowing that
          somebody else did.
        </p>
      </>,
    );
  }

  if (status && status.state !== 'pending') {
    return shell(
      <>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">
          {status.state === 'expired' ? 'That code expired' : 'That code has been used'}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Run <span className="font-mono text-foreground">npx sovereign-mcp@latest link</span> again
          for a fresh one.
        </p>
      </>,
    );
  }

  const spends = status?.scope === 'spend';

  return shell(
    <>
      <h1 className="mt-6 text-xl font-semibold tracking-tight">Link a terminal</h1>

      <div className="mt-5 rounded-lg border border-hairline bg-background px-3 py-3 text-center">
        <div className="text-[10px] uppercase tracking-wider text-muted">Check this matches your terminal</div>
        <div className="mt-1 font-mono text-2xl tracking-[0.2em]">{status?.code ?? code}</div>
        {status?.label && <div className="mt-1 font-mono text-[10px] text-muted">{status.label}</div>}
      </div>

      <div className="mt-4 rounded-lg border border-hairline bg-background px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider text-muted">This will let Claude Code</div>
        <ul className="mt-1.5 flex flex-col gap-1 text-[11px] leading-relaxed text-muted">
          <li>Search the marketplace and read track records. Free, no payment.</li>
          {spends ? (
            <>
              <li className="text-foreground">
                Pay workers from this wallet, without asking you each time.
              </li>
              <li>
                Only within your spend limits, only to workers on your allowlist, and
                never above your approval threshold, which still needs you in a browser.
              </li>
            </>
          ) : (
            <li>Hand payments back to you in the browser to confirm.</li>
          )}
        </ul>
      </div>

      {!ready ? null : !authenticated ? (
        <>
          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            Sign in to approve. If you have never used Sovereign, this creates your
            account and wallet.
          </p>
          <button
            onClick={login}
            className="mt-3 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
          >
            Sign in to continue
          </button>
        </>
      ) : (
        <>
          <div className="mt-4 rounded-lg border border-hairline bg-background px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-muted">Linking to</div>
            {address ? (
              <Copyable value={address} className="mt-0.5 break-all font-mono text-xs hover:text-foreground">
                {address}
              </Copyable>
            ) : (
              <div className="mt-0.5 font-mono text-xs text-muted">creating your wallet…</div>
            )}
            {user?.email?.address && (
              <div className="mt-1 text-[10px] text-muted">{user.email.address}</div>
            )}
          </div>

          {spends && facts && (
            <div className="mt-3 rounded-lg border border-hairline bg-background px-3 py-2 text-[11px] leading-relaxed text-muted">
              {!facts.found
                ? 'Privy does not list this wallet on your account, so it cannot be delegated.'
                : !facts.embedded
                  ? 'This is an external wallet. Delegation applies only to the Privy embedded wallet.'
                  : !PRIVY_SIGNER_ID
                    ? (facts.delegated
                        ? 'This wallet is already delegated, so approving will not ask again.'
                        : 'No signer id is configured, so this will try the older delegation flow and may not work.')
                    : facts.delegated
                      ? 'This wallet already has a signer. Approving confirms it is the current one, and does nothing if it already is.'
                      : 'Approving attaches Sovereign as a signer on this wallet, so it can pay inside your limits.'}
            </div>
          )}

          {needsName && (
            <label className="mt-3 block text-sm">
              <span className="text-muted">Name your account</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Maya Chen"
                className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 outline-none focus:border-accent"
              />
              <span className="mt-1 block text-[10px] leading-relaxed text-muted">
                This is what buyers see on anything you list.
              </span>
            </label>
          )}

          {err && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

          <div className="mt-5 flex gap-3">
            <button
              disabled={!address || !!busy}
              onClick={approve}
              className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy === 'delegating'
                ? 'Granting permission…'
                : busy === 'signing'
                  ? 'Check your wallet…'
                  : busy === 'sending'
                    ? 'Linking…'
                    : spends ? 'Approve and allow spending' : 'Approve'}
            </button>
            <button
              onClick={deny}
              className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted transition-colors hover:text-foreground"
            >
              Reject
            </button>
          </div>

          {busy && (
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              {busy === 'delegating'
                ? 'Privy is asking permission for Sovereign to sign payments with this wallet. Its dialog may have opened behind this window.'
                : busy === 'signing'
                  ? 'Your wallet is waiting for a signature. Nothing is spent by signing this.'
                  : 'Sent. Waiting on Sovereign.'}
            </p>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            If you did not just run that command, reject this.
          </p>
        </>
      )}
    </>,
  );
}
