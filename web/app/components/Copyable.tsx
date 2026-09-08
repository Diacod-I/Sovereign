'use client';
import { useState } from 'react';

// Click-to-copy. Shows `children` (e.g. a shortened address); copies `value` (full).
export default function Copyable({
  value,
  children,
  className = '',
  copiedLabel = 'Copied',
}: {
  value: string;
  children?: React.ReactNode;
  className?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <button type="button" onClick={copy} title="Click to copy" className={`inline-flex items-center gap-1.5 ${className}`}>
      <span>{copied ? copiedLabel : (children ?? value)}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60" aria-hidden="true">
        {copied ? (
          <polyline points="20 6 9 17 4 12" />
        ) : (
          <>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </>
        )}
      </svg>
    </button>
  );
}
