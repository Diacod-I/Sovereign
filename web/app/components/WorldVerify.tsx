'use client';

import { useRef, useState } from 'react';
import {
  IDKitRequestWidget,
  IDKitErrorCodes,
  selfieCheckLegacy,
  type IDKitResult,
  type RpContext,
} from '@worldcoin/idkit';
import {
  WORLD_ACTION,
  WORLD_APP_ID,
  WORLD_ENVIRONMENT,
  worldStatus,
  writeVerification,
  type SellerVerification,
} from '../lib/world';
import {
  explainAttestFailure,
  useAttest,
  type Attestation,
} from '../lib/verification';

type Props = {
  wallet?: string | null;
  onVerified: (v: SellerVerification) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
};

type VerifiedProof = Pick<SellerVerification, 'nullifierHash' | 'level'>;

const baseCls =
  'w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors border border-hairline text-foreground hover:border-accent disabled:opacity-40';

function describeError(error: IDKitErrorCodes) {
  switch (error) {
    case 'user_rejected':
    case 'verification_rejected':
      return 'Verification was cancelled in World App.';
    case 'credential_unavailable':
    case 'world_id_3_not_available':
      return 'This World ID does not have Selfie Check available.';
    case 'max_verifications_reached':
    case 'nullifier_replayed':
      return 'This World ID has already verified this seller action.';
    case 'invalid_rp_signature':
    case 'unknown_rp':
    case 'inactive_rp':
      return 'World setup is incomplete. Check the RP ID and signing key.';
    case 'invalid_network':
      return 'The World App and configured environment do not match.';
    case 'connection_failed':
      return 'World could not be reached. Please try again.';
    default:
      return 'World verification could not be completed. Please try again.';
  }
}

// Requests are server-signed, bound to the seller's Privy wallet, and verified
// by our server before the seller receives a World ID badge.
export default function WorldVerify({ wallet, onVerified, label, className, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const verifiedProofRef = useRef<VerifiedProof | null>(null);
  const serverErrorRef = useRef<string | null>(null);
  const attestationRef = useRef<Attestation | null>(null);
  // A proof that passed the server but has not reached the chain yet. Held so a
  // rejected or failed wallet prompt leaves a retry rather than a dead end: the
  // World check is the expensive step and must not have to be redone.
  const [unpublished, setUnpublished] = useState<{ proof: VerifiedProof; attestation: Attestation } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const cls = className ?? baseCls;
  const text = label ?? 'Verify with World ID (Selfie Check)';
  const signal = wallet?.toLowerCase();
  const attest = useAttest(signal ?? null);

  const persist = (proof: VerifiedProof, tx?: string) => {
    const verification: SellerVerification = {
      wallet: signal || '',
      nullifierHash: proof.nullifierHash,
      level: proof.level,
      at: Date.now(),
      tx,
    };
    writeVerification(verification);
    onVerified(verification);
  };

  /**
   * Publishes the attestation as an Arc transaction. Separated from the World
   * flow because it costs gas and can be declined -- and because failing here
   * must not throw away a proof that already cost the user a selfie.
   */
  const publish = async (proof: VerifiedProof, attestation: Attestation) => {
    setPublishing(true);
    setErr(null);
    try {
      const tx = await attest(attestation);
      setUnpublished(null);
      persist(proof, tx);
    } catch (e) {
      setUnpublished({ proof, attestation });
      setErr(explainAttestFailure(e));
      // Keep the local badge either way: the human did verify. It is just not
      // public yet, which the caller can see from the missing tx.
      persist(proof);
    } finally {
      setPublishing(false);
    }
  };

  const startVerification = async () => {
    if (!signal || busy) return;
    setErr(null);
    setBusy(true);
    verifiedProofRef.current = null;
    serverErrorRef.current = null;
    try {
      const response = await fetch('/api/world-rp-signature', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'World ID is not configured.');
      setRpContext(data as RpContext);
      setOpen(true);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not start World verification.');
    } finally {
      setBusy(false);
    }
  };

  const status = worldStatus();

  // Explicitly opted in, for local work without Portal credentials. Labelled so it
  // can never be mistaken for a real verification.
  if (status.mode === 'demo') {
    return (
      <div>
        <button
          type="button"
          disabled={disabled || !signal}
          onClick={() => persist({ nullifierHash: 'demo', level: 'demo' })}
          className={cls}
        >
          {text} <span className="text-muted">· demo</span>
        </button>
        <div className="mt-2 text-[11px] leading-relaxed text-amber-400">
          Demo mode: this grants a badge without checking anything. Never enable
          NEXT_PUBLIC_WORLD_DEMO on a deployed site.
        </div>
      </div>
    );
  }

  // Misconfigured. Refuse rather than fall back to handing out badges, and name
  // exactly what is missing so it is fixable without reading the source.
  if (status.mode === 'unconfigured') {
    return (
      <div>
        <button type="button" disabled className={cls}>
          {text}
        </button>
        <div className="mt-2 text-[11px] leading-relaxed text-red-400">
          World ID is not configured, so nobody can be verified here.
          {status.missing.length > 0 && (
            <span className="mt-1 block font-mono text-muted">
              missing: {status.missing.join(', ')}
            </span>
          )}
          <span className="mt-1 block text-muted">
            These are build-time variables. After adding them, redeploy.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={disabled || busy || publishing || !signal}
        onClick={unpublished ? () => void publish(unpublished.proof, unpublished.attestation) : startVerification}
        className={cls}
      >
        {publishing
          ? 'Recording on Arc…'
          : unpublished
            ? 'Publish verification on Arc'
            : busy
              ? 'Preparing World ID…'
              : text}
      </button>

      {unpublished && !publishing && (
        <div className="mt-2 text-[11px] leading-relaxed text-amber-400">
          You are verified, but only on this device. Publishing it on Arc is what
          lets buyers see it.
        </div>
      )}

      {rpContext && signal && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={WORLD_APP_ID}
          action={WORLD_ACTION}
          rp_context={rpContext}
          preset={selfieCheckLegacy({ signal })}
          allow_legacy_proofs
          environment={WORLD_ENVIRONMENT}
          handleVerify={async (idkitResponse: IDKitResult) => {
            setBusy(true);
            try {
              const response = await fetch('/api/world-verify', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ idkitResponse, wallet: signal }),
              });
              const data = await response.json();
              if (!response.ok || !data.ok) {
                const detail = data.detail || 'World verification failed.';
                // Stash the server's actual reason. IDKit collapses whatever we
                // throw into a generic error code, so without this the seller
                // only ever sees "could not be completed".
                serverErrorRef.current = detail;
                throw new Error(detail);
              }
              serverErrorRef.current = null;
              verifiedProofRef.current = {
                nullifierHash: data.nullifierHash,
                level: data.level || 'selfie',
              };
              attestationRef.current = (data.attestation as Attestation | null) ?? null;
            } finally {
              setBusy(false);
            }
          }}
          onSuccess={() => {
            const proof = verifiedProofRef.current;
            if (!proof) {
              setErr(serverErrorRef.current || 'World returned a proof, but it was not accepted by the server.');
              return;
            }
            const attestation = attestationRef.current;
            // No attestation means the contract or attestor key is not configured.
            // Fall back to the local-only badge rather than blocking on it.
            if (attestation) void publish(proof, attestation);
            else persist(proof);
          }}
          onError={(errorCode) => setErr(serverErrorRef.current || describeError(errorCode))}
        />
      )}

      {err && <div className="mt-2 text-[11px] text-red-400">{err}</div>}
    </div>
  );
}
