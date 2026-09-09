// app/components/wallet.tsx
// Shared live-wallet UI for both the buyer and seller dashboards. Everything here
// reads the logged-in Privy embedded wallet on Arc via ../lib/arc.
'use client';

import { useEffect, useState } from 'react';
import { useSendTransaction } from '@privy-io/react-auth';
import { parseUnits } from 'viem';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import QRCode from 'qrcode';
import Copyable from './Copyable';
import {
  ARC_CHAIN_ID,
  FAUCET_URL,
  RANGES,
  buildBalanceSeries,
  fetchBalance,
  fetchWalletData,
  formatUsdc,
  relTime,
  shortHash,
  txUrl,
  type ArcTx,
  type BalancePoint,
  type RangeKey,
} from '../lib/arc';

// ---------------------------------------------------------------- hooks

export type WalletData = {
  balance: number | null;
  txs: ArcTx[];
  history: BalancePoint[];
  loading: boolean;
  error: string | null;
  reload: () => void;
};

/** Live balance + tx history + balance history for an address, with focus-refresh. */
export function useWalletData(address: string | null): WalletData {
  const [balance, setBalance] = useState<number | null>(null);
  const [txs, setTxs] = useState<ArcTx[]>([]);
  const [history, setHistory] = useState<BalancePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchWalletData(address)
      .then((d) => { if (alive) { setBalance(d.balance); setTxs(d.txs); setHistory(d.history); setLoading(false); } })
      .catch(() => { if (alive) { setError('Could not reach the Arc explorer.'); setLoading(false); } });
    return () => { alive = false; };
  }, [address, nonce]);

  // Refetch when the tab regains focus (e.g. returning from the faucet).
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') setNonce((n) => n + 1); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  return { balance, txs, history, loading, error, reload };
}

/** Returns a withdraw fn: native USDC transfer signed by the embedded wallet on Arc. */
export function useWithdraw(address: string | null, onDone: () => void) {
  const { sendTransaction } = useSendTransaction();
  return async (to: string, amount: number): Promise<string> => {
    if (!address) throw new Error('No wallet');
    // Arc's native value fields are 18-decimal wei; encode exactly with parseUnits.
    const base = parseUnits(String(amount), 18);
    const { hash } = await sendTransaction(
      { to, value: '0x' + base.toString(16), chainId: ARC_CHAIN_ID },
      { address }
    );
    onDone();
    return hash;
  };
}

// ---------------------------------------------------------------- small internals

function Pill({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    received: 'text-accent',
    failed: 'text-red-400',
    sent: 'text-muted',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider ${map[kind] ?? 'text-muted'}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
      {kind}
    </span>
  );
}

function ArrowUpRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="8 7 17 7 17 16" />
    </svg>
  );
}

function CenterNote({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className={`flex h-full items-center justify-center px-6 text-center text-sm ${tone === 'error' ? 'text-red-400' : 'text-muted'}`}>
      <div>{children}</div>
    </div>
  );
}

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6" onClick={onClose}>
      <div className="relative w-full max-w-md rounded-2xl border border-hairline bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 text-muted transition-colors hover:text-foreground">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
        </button>
        {children}
      </div>
    </div>
  );
}

const AXIS = { stroke: '#8a8a8a', fontSize: 12, tickLine: false, axisLine: false } as const;
const TOOLTIP_STYLE = {
  contentStyle: { background: '#0b0d12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e5e5e5' },
  itemStyle: { color: '#e5e5e5' },
} as const;

// ---------------------------------------------------------------- BalanceCard

export function BalanceCard({
  series, range, setRange, loading, error, hasWallet, onAdd,
}: {
  series: ReturnType<typeof buildBalanceSeries>;
  range: RangeKey;
  setRange: (r: RangeKey) => void;
  loading: boolean;
  error: string | null;
  hasWallet: boolean;
  onAdd: () => void;
}) {
  const empty = !loading && !error && series.latest === 0 && series.points.every((p) => p.usdc === 0);
  const yfmt = (v: number) => formatUsdc(v);

  return (
    <div className="mt-8 rounded-xl border border-hairline bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Balance</span>
          {!loading && !error && (
            <span className="font-mono text-[11px] text-muted">{formatUsdc(series.latest)} USDC</span>
          )}
          {series.fellBack && (
            <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] text-muted">
              under 5 years — showing 5-year view
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${range === r.key ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="h-64 px-4 py-4">
        {loading ? (
          <CenterNote>Loading balance from Arc…</CenterNote>
        ) : error ? (
          <CenterNote tone="error">{error}</CenterNote>
        ) : empty ? (
          <CenterNote>
            No balance yet.{' '}
            {hasWallet && (
              <button onClick={onAdd} className="text-accent underline underline-offset-2">Add funds</button>
            )}{' '}
            to get started.
          </CenterNote>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series.points} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
              <defs>
                <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2FFF00" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#2FFF00" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={20} />
              <YAxis {...AXIS} width={56} tickFormatter={yfmt} />
              <Tooltip cursor={{ stroke: 'rgba(255,255,255,0.15)' }} {...TOOLTIP_STYLE} formatter={(v) => [`${formatUsdc(Number(v))} USDC`, 'Balance'] as [string, string]} />
              <Area type="monotone" dataKey="usdc" stroke="#2FFF00" strokeWidth={2} fill="url(#balFill)" dot={false} activeDot={{ r: 3 }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ActivityFeed

const PAGE_SIZES = [5, 20, 50];

function pageList(current: number, count: number): (number | '…')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const lo = Math.max(2, current - 1);
  const hi = Math.min(count - 1, current + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < count - 1) out.push('…');
  out.push(count);
  return out;
}

export function ActivityFeed({
  items, loading, error, title = 'Recent activity',
}: {
  items: ArcTx[];
  loading: boolean;
  error: string | null;
  title?: string;
}) {
  const [pageSize, setPageSize] = useState(5);
  const [page, setPage] = useState(1);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => { if (page > pageCount) setPage(1); }, [pageCount, page]);

  const start = (page - 1) * pageSize;
  const rows = items.slice(start, start + pageSize);

  return (
    <div className="mt-8 rounded-xl border border-hairline bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
        <span className="text-sm font-medium">{title}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted">Show</span>
          <div className="flex items-center gap-0.5">
            {PAGE_SIZES.map((n) => (
              <button
                key={n}
                onClick={() => { setPageSize(n); setPage(1); }}
                className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${pageSize === n ? 'bg-[#1c1c1c] text-foreground' : 'text-muted hover:text-foreground'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="px-5 py-8 text-center text-sm text-muted">Loading transactions…</div>
      ) : error ? (
        <div className="px-5 py-8 text-center text-sm text-red-400">{error}</div>
      ) : total === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted">No transactions yet.</div>
      ) : (
        <>
          {rows.map((t) => {
            const inbound = t.direction === 'in';
            const counterparty = inbound ? t.from : t.to ?? 'contract';
            const kind = t.status === 'error' ? 'failed' : inbound ? 'received' : 'sent';
            const isTransfer = t.value > 0;
            const action = isTransfer ? (inbound ? 'Received from' : 'Sent to') : (t.method || 'Contract call') + ' ·';
            const amount = isTransfer
              ? `${inbound ? '+' : '−'}${formatUsdc(t.value)} USDC`
              : t.fee > 0 ? `${formatUsdc(t.fee)} gas` : '—';
            return (
              <div key={t.hash + ':' + t.from + ':' + t.value + ':' + t.ts} className="flex items-center justify-between border-b border-hairline px-5 py-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate">
                    {action}{' '}
                    <a href={txUrl(t.hash)} target="_blank" rel="noreferrer" className="font-mono text-muted underline-offset-2 hover:text-foreground hover:underline">
                      {shortHash(counterparty)}
                    </a>
                  </div>
                  <div className="font-mono text-[11px] text-muted">{relTime(t.ts)}</div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-sm">{amount}</span>
                  <Pill kind={kind} />
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[11px] text-muted">
            <span className="font-mono">{start + 1}–{Math.min(start + pageSize, total)} of {total}</span>
            {pageCount > 1 && (
              <div className="flex items-center gap-0.5">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="rounded-md px-2 py-1 font-mono transition-colors hover:text-foreground disabled:opacity-30">‹</button>
                {pageList(page, pageCount).map((p, i) =>
                  p === '…' ? (
                    <span key={'e' + i} className="px-1.5 font-mono text-muted">…</span>
                  ) : (
                    <button key={p} onClick={() => setPage(p)} className={`rounded-md px-2 py-1 font-mono transition-colors ${page === p ? 'bg-[#1c1c1c] text-foreground' : 'hover:text-foreground'}`}>{p}</button>
                  )
                )}
                <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page === pageCount} className="rounded-md px-2 py-1 font-mono transition-colors hover:text-foreground disabled:opacity-30">›</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- money modals

export function DepositModal({ address, onFunded, onClose }: { address: string | null; onFunded: () => void; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [received, setReceived] = useState<number | null>(null);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    QRCode.toDataURL(address, { margin: 1, width: 240, color: { dark: '#0a0a0a', light: '#ffffff' } })
      .then((url) => { if (alive) setQr(url); })
      .catch(() => {});
    return () => { alive = false; };
  }, [address]);

  useEffect(() => {
    if (!address) return;
    let alive = true;
    let baseline: number | null = null;
    const tick = async () => {
      try {
        const bal = await fetchBalance(address);
        if (!alive) return;
        if (baseline === null) { baseline = bal; return; }
        if (bal > baseline + 1e-9) {
          setReceived(+(bal - baseline).toFixed(6));
          onFunded();
          baseline = bal;
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(id); };
  }, [address, onFunded]);

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Add funds</h2>
      <p className="mt-1 text-sm text-muted">Send USDC to your wallet on Arc. On testnet, mint free USDC from Circle&apos;s faucet, then send it to this address.</p>

      {received !== null && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          Received +{formatUsdc(received)} USDC
        </div>
      )}

      <div className="mt-5 flex flex-col items-center gap-3">
        {qr ? (
          <img src={qr} alt="Deposit address QR" width={168} height={168} className="rounded-lg" />
        ) : (
          <div className="h-[168px] w-[168px] animate-pulse rounded-lg bg-[#1c1c1c]" />
        )}
      </div>

      <div className="mt-4 rounded-lg border border-hairline bg-background p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">Your wallet address (Arc)</div>
        {address ? (
          <Copyable value={address} className="mt-1 break-all font-mono text-xs text-muted hover:text-foreground">{address}</Copyable>
        ) : (
          <div className="mt-1 font-mono text-xs text-muted">wallet not ready</div>
        )}
      </div>

      <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="mt-3 block w-full rounded-lg bg-accent px-4 py-2.5 text-center text-sm font-medium text-black transition-opacity hover:opacity-90">
        Open Circle faucet →
      </a>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] leading-snug text-muted">
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-muted" />
        Waiting for a deposit — this updates automatically when funds land.
      </p>
    </ModalShell>
  );
}

export function WithdrawModal({
  address, balance, onWithdraw, onClose,
}: {
  address: string | null;
  balance: number | null;
  onWithdraw: (to: string, amount: number) => Promise<string>;
  onClose: () => void;
}) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [hash, setHash] = useState<string | null>(null);

  const amt = Number(amount);
  const validTo = /^0x[a-fA-F0-9]{40}$/.test(to.trim());
  const validAmt = amount !== '' && amt > 0 && (balance === null || amt <= balance);
  const canSend = validTo && validAmt && !busy;

  const submit = async () => {
    setErr(null);
    if (!canSend) return;
    setBusy(true);
    try {
      const h = await onWithdraw(to.trim(), amt);
      setHash(h);
      setDone(true);
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : 'Transaction failed or was rejected.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-semibold tracking-tight">Withdraw</h2>
      {done ? (
        <>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            Sent {formatUsdc(amt)} USDC
          </div>
          <p className="mt-3 text-sm text-muted">To <span className="font-mono">{shortHash(to.trim())}</span>. Your balance will update shortly.</p>
          {hash && (
            <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
              View on Arcscan <ArrowUpRight />
            </a>
          )}
          <button onClick={onClose} className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black">Done</button>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">Send USDC from your wallet to any Arc address. Signed by your embedded wallet.</p>
          <div className="mt-2 text-[11px] text-muted">Available: <span className="font-mono text-foreground">{balance === null ? '—' : formatUsdc(balance)} USDC</span></div>

          <div className="mt-4 flex flex-col gap-3">
            <label className="text-sm">
              <span className="text-muted">Destination address</span>
              <input autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" className="mt-1 w-full rounded-lg border border-hairline bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent" />
              {to !== '' && !validTo && <span className="mt-1 block text-[11px] text-red-400">Not a valid address.</span>}
            </label>
            <label className="text-sm">
              <span className="text-muted">Amount (USDC)</span>
              <span className="mt-1 flex items-center rounded-lg border border-hairline bg-background pr-2 focus-within:border-accent">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="w-full bg-transparent px-3 py-2 text-sm outline-none" />
                {balance !== null && (
                  <button type="button" onClick={() => setAmount(String(balance))} className="rounded-md px-2 py-1 font-mono text-[11px] text-muted hover:text-foreground">MAX</button>
                )}
              </span>
              {amount !== '' && amt > 0 && balance !== null && amt > balance && <span className="mt-1 block text-[11px] text-red-400">Exceeds your balance.</span>}
            </label>
          </div>

          {err && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-[11px] text-red-400">{err}</div>}

          <div className="mt-5 flex gap-3">
            <button disabled={!canSend} onClick={submit} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? 'Confirm in wallet…' : 'Withdraw'}
            </button>
            <button onClick={onClose} className="rounded-lg border border-hairline px-4 py-2.5 text-sm text-muted hover:text-foreground">Cancel</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
