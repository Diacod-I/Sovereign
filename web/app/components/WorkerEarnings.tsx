'use client';

import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchWorkerEarnings, type WorkerEarning } from '../lib/receipts';

/**
 * What each worker you have listed has earned.
 *
 * A horizontal bar rather than the treemap this replaced: the job here is
 * comparing magnitude across a handful of named things, and area is much harder
 * to compare than length. A treemap earns its place at twenty-plus items with a
 * hierarchy; at two or three it is one large rectangle with nowhere to put the
 * name.
 *
 * One hue, sorted high to low, every bar direct-labelled. There is a single
 * series, so there is nothing for a second colour to distinguish and no legend
 * to draw; paused workers are dimmed rather than recoloured, because dimming
 * reads as "less" without claiming to be a different category.
 */

const AXIS = { stroke: '#8a8a8a', fontSize: 11, tickLine: false, axisLine: false } as const;

const ACCENT = '#2FFF00';
const PAUSED = '#2FFF0055';

/** Fixed 2dp. formatUsdc drops trailing zeros, which on a column of money reads
 *  as ragged precision ($12.4 beside $2.05) rather than as tidiness. */
const money = (v: number) => `$${v.toFixed(2)}`;

export default function WorkerEarnings({ owner }: { owner: string | null }) {
  const [rows, setRows] = useState<WorkerEarning[] | null>(null);

  useEffect(() => {
    if (!owner) { setRows([]); return; }
    let alive = true;
    fetchWorkerEarnings(owner)
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [owner]);

  const earning = (rows ?? []).filter((r) => r.earned > 0);
  const total = earning.reduce((s, r) => s + r.earned, 0);

  return (
    <div className="rounded-xl border border-hairline bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">What your workers earned</h2>
        {earning.length > 0 && (
          <span className="font-mono text-[11px] text-muted">{money(total)} total</span>
        )}
      </div>

      {rows === null ? (
        <div className="mt-4 h-40 animate-pulse rounded-lg bg-[#1c1c1c]" />
      ) : earning.length === 0 ? (
        <div className="mt-4 flex h-40 items-center justify-center rounded-lg border border-dashed border-hairline px-4 text-center">
          <p className="text-[11px] leading-relaxed text-muted">
            {rows.length === 0
              ? 'You have not listed a worker yet. Anything you list and anyone hires shows up here.'
              : 'Nothing graded yet. A worker appears here once a buyer has paid it and filed a receipt.'}
          </p>
        </div>
      ) : (
        <>
          <div className="mt-4" style={{ height: Math.max(120, earning.length * 34 + 28) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={earning}
                layout="vertical"
                margin={{ top: 4, right: 64, left: 0, bottom: 0 }}
                barCategoryGap={10}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                <XAxis type="number" {...AXIS} tickFormatter={(v) => money(Number(v))} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={132}
                  interval={0}
                  {...AXIS}
                  // Truncated short enough to stay on ONE line inside `width`.
                  // Recharts wraps a tick that does not fit, and a two-line tick
                  // next to a thin bar reads as two rows of data rather than one.
                  tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 13) + '…' : v)}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={{
                    background: '#0b0d12',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#e5e5e5' }}
                  itemStyle={{ color: '#e5e5e5' }}
                  formatter={(v, _n, item) => {
                    const r = item?.payload as WorkerEarning | undefined;
                    return [
                      `${money(Number(v))} over ${r?.calls ?? 0} graded call${r?.calls === 1 ? '' : 's'}`,
                      r?.active ? 'Earned' : 'Earned (paused)',
                    ] as [string, string];
                  }}
                />
                {/* maxBarSize matters more than it looks: without it a single
                    worker stretches to the full plot height and reads as a block
                    of colour rather than a measurement. */}
                <Bar dataKey="earned" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
                  {earning.map((r) => (
                    <Cell key={r.id} fill={r.active ? ACCENT : PAUSED} />
                  ))}
                  <LabelList
                    dataKey="earned"
                    position="right"
                    offset={8}
                    // Text tokens, never the series colour: the bar carries the
                    // identity, the number stays ordinary ink.
                    fill="#8a8a8a"
                    fontSize={11}
                    formatter={(v: React.ReactNode) => money(Number(v))}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-muted">
            Counted from on-chain receipts, so this is a floor: a paid call nobody
            graded leaves no receipt and is not in here. Dimmed bars are paused
            workers.
          </p>
        </>
      )}
    </div>
  );
}
