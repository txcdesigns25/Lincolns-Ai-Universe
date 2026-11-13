export const usd = (cents: number | null | undefined, opts: { sign?: boolean } = {}) => {
  const v = (cents ?? 0) / 100;
  const s = v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  return opts.sign && v > 0 ? `+${s}` : s;
};
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
export const ago = (d: string | Date | null | undefined) => {
  if (!d) return "never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) return `in ${fmtDur(-s)}`;
  return `${fmtDur(s)} ago`;
};
function fmtDur(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
export const pct = (x: number | null | undefined) => (x == null ? "n/a" : `${(x * 100).toFixed(0)}%`);
