import Link from "next/link";
import { usd } from "@/lib/format";

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rise rounded-xl border border-line bg-panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="rise rounded-xl border border-line bg-panel px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-faint">{label}</div>
      <div className={`tabular mt-1 text-2xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  active: "bg-good/15 text-good", succeeded: "bg-good/15 text-good", approved: "bg-good/15 text-good", published: "bg-good/15 text-good", allowed: "bg-good/15 text-good", concluded: "bg-good/15 text-good",
  paused: "bg-warn/15 text-warn", queued: "bg-accent/15 text-accent", running: "bg-accent/20 text-accent", pending: "bg-warn/15 text-warn", pending_approval: "bg-warn/15 text-warn", waiting_approval: "bg-warn/15 text-warn", proposed: "bg-warn/15 text-warn", warning: "bg-warn/15 text-warn",
  error: "bg-bad/15 text-bad", failed: "bg-bad/15 text-bad", dead: "bg-bad/15 text-bad", rejected: "bg-bad/15 text-bad", denied: "bg-bad/15 text-bad", critical: "bg-bad/15 text-bad",
};
export function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  const key = tone ?? String(children);
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${BADGE[key] ?? "bg-line text-muted"}`}>{children}</span>;
}

export function Money({ cents, sign }: { cents: number; sign?: boolean }) {
  return <span className={`tabular ${sign ? (cents > 0 ? "text-good" : cents < 0 ? "text-bad" : "") : ""}`}>{usd(cents, { sign })}</span>;
}

export function Table({ head, rows, empty = "Nothing here yet." }: { head: React.ReactNode[]; rows: React.ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-faint">{empty}</p>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-faint">
            {head.map((h, i) => <th key={i} className="px-4 pb-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line/70 hover:bg-panel-2/60">
              {r.map((c, j) => <td key={j} className="px-4 py-2 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Button({ children, tone = "default", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger" | "good" }) {
  const t = { default: "border-line bg-panel-2 hover:bg-line", primary: "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25",
    danger: "border-bad/40 bg-bad/15 text-bad hover:bg-bad/25", good: "border-good/40 bg-good/15 text-good hover:bg-good/25" }[tone];
  return <button {...props} className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${t} ${props.className ?? ""}`}>{children}</button>;
}

export function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm hover:bg-line">{children}</Link>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-faint">{children}</p>;
}
