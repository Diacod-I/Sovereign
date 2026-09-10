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
  worldConfigured,
  writeVerification,
  type SellerVerification,
} from '../lib/world';

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
  const cls = className ?? baseCls;
  const text = label ?? 'Verify with World ID (Selfie Check)';
  const signal = wallet?.toLowerCase();

  const persist = (proof: VerifiedProof) => {
    const verification: SellerVerification = {
      wallet: signal || '',
      nullifierHash: proof.nullifierHash,
      level: proof.level,
      at: Date.now(),
    };
    writeVerification(verification);
    onVerified(verification);
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

  // Retain a walkable demo flow until the Portal credentials are provided.
  if (!worldConfigured) {
    return (
      <button
        type="button"
        disabled={disabled || !signal}
        onClick={() => persist({ nullifierHash: 'demo', level: 'demo' })}
        className={cls}
      >
        {text} <span className="text-muted">· demo</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        disabled={disabled || busy || !signal}
        onClick={startVerification}
        className={cls}
      >
        {busy ? 'Preparing World ID…' : text}
      </button>

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
            } finally {
              setBusy(false);
            }
          }}
          onSuccess={() => {
            const proof = verifiedProofRef.current;
            if (proof) persist(proof);
            else setErr(serverErrorRef.current || 'World returned a proof, but it was not accepted by the server.');
          }}
          onError={(errorCode) => setErr(serverErrorRef.current || describeError(errorCode))}
        />
      )}

      {err && <div className="mt-2 text-[11px] text-red-400">{err}</div>}
    </div>
  );
}
