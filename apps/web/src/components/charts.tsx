import { usd } from "@/lib/format";

/** Grouped revenue/expense bars with a profit line. Pure SVG, no client JS. */
export function FinanceChart({ data }: { data: { label: string; revenue: number; expenses: number; profit: number }[] }) {
  const W = 760, H = 220, P = { l: 56, r: 12, t: 12, b: 26 };
  const max = Math.max(100, ...data.map((d) => Math.max(d.revenue, d.expenses)));
  const min = Math.min(0, ...data.map((d) => d.profit));
  const span = max - min || 1;
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - (v - min) / span);
  const bw = (W - P.l - P.r) / Math.max(1, data.length);
  const ticks = [min, min + span / 2, max];
  const every = Math.ceil(data.length / 8);
  const path = data.map((d, i) => `${i ? "L" : "M"}${P.l + bw * i + bw / 2},${y(d.profit)}`).join(" ");
  const empty = data.every((d) => !d.revenue && !d.expenses);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Revenue, expenses and profit over time">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeDasharray={t === 0 ? "" : "3 4"} />
            <text x={P.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--color-faint)">{usd(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = P.l + bw * i;
          const w = Math.max(2, bw / 2 - 2);
          return (
            <g key={i}>
              <title>{`${d.label}: revenue ${usd(d.revenue)}, expenses ${usd(d.expenses)}, profit ${usd(d.profit)}`}</title>
              <rect x={x + bw / 2 - w - 1} y={y(d.revenue)} width={w} height={Math.max(0, y(0) - y(d.revenue))} rx="2" fill="var(--color-good)" opacity=".85" />
              <rect x={x + bw / 2 + 1} y={y(d.expenses)} width={w} height={Math.max(0, y(0) - y(d.expenses))} rx="2" fill="var(--color-bad)" opacity=".7" />
              {i % every === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--color-faint)">{d.label}</text>}
            </g>
          );
        })}
        {!empty && <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="2" />}
        {empty && <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="12" fill="var(--color-faint)">No verified financial activity in this period</text>}
      </svg>
      <figcaption className="mt-2 flex gap-4 text-xs text-muted">
        <Legend color="var(--color-good)">Verified revenue</Legend>
        <Legend color="var(--color-bad)">Expenses</Legend>
        <Legend color="var(--color-accent)" line>Net profit</Legend>
      </figcaption>
    </figure>
  );
}

function Legend({ color, children, line }: { color: string; children: React.ReactNode; line?: boolean }) {
  return <span className="inline-flex items-center gap-1.5"><span style={{ background: color }} className={line ? "h-0.5 w-3" : "h-2.5 w-2.5 rounded-sm"} />{children}</span>;
}

/** Horizontal bars for per-business comparisons. Handles negatives. */
export function HBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-muted">{r.label}</span>
          <span className="h-2 rounded-full bg-panel-2">
            <span className="block h-2 rounded-full" style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: r.value < 0 ? "var(--color-bad)" : "var(--color-good)" }} />
          </span>
          <span className={`tabular w-24 text-right ${r.value < 0 ? "text-bad" : ""}`}>{usd(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Meter({ used, limit }: { used: number; limit: number }) {
  const p = limit > 0 ? Math.min(1, used / limit) : 1;
  const color = p >= 0.9 ? "var(--color-bad)" : p >= 0.7 ? "var(--color-warn)" : "var(--color-accent)";
  return (
    <div className="min-w-28">
      <div className="h-1.5 rounded-full bg-panel-2"><div className="h-1.5 rounded-full" style={{ width: `${p * 100}%`, background: color }} /></div>
      <div className="tabular mt-1 text-[11px] text-muted">{usd(used)} / {usd(limit)}</div>
    </div>
  );
}
