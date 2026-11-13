"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV = [
  ["/", "Overview"], ["/ceo", "Universe CEO"], ["/agents", "All Agents"], ["/revenue", "Revenue"], ["/expenses", "Expenses"],
  ["/budgets", "Budgets"], ["/activity", "Activity Feed"], ["/customers", "Customers"], ["/tasks", "Tasks"],
  ["/store", "Store (A01)"], ["/memory", "Memory & Learning"], ["/approvals", "Approvals"], ["/settings", "Settings"],
] as const;

export function Nav({ pending, workerOnline }: { pending: number; workerOnline: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const items = (
    <ul className="space-y-0.5">
      {NAV.map(([href, label]) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <li key={href}>
            <Link href={href} onClick={() => setOpen(false)}
              className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${active ? "bg-panel-2 text-ink" : "text-muted hover:bg-panel-2/60 hover:text-ink"}`}>
              {label}
              {href === "/approvals" && pending > 0 && <span className="rounded-full bg-warn/20 px-1.5 text-[11px] text-warn">{pending}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
  const brand = (
    <div className="flex items-center gap-2 px-3">
      <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px] shadow-accent" />
      <span className="font-semibold tracking-tight">AI Universe</span>
    </div>
  );
  const status = (
    <div className="mt-6 flex items-center gap-2 px-3 text-xs text-muted">
      <span className={`h-2 w-2 rounded-full ${workerOnline ? "pulse-dot bg-good" : "bg-faint"}`} />
      {workerOnline ? "Worker online" : "Worker offline"}
    </div>
  );
  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line px-3 py-5 lg:flex">
        {brand}<nav className="mt-6 flex-1">{items}</nav>{status}
      </aside>
      <div className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 backdrop-blur lg:hidden">
        {brand}
        <button onClick={() => setOpen(!open)} className="rounded-lg border border-line px-3 py-1 text-sm" aria-expanded={open}>Menu</button>
      </div>
      {open && <div className="fixed inset-x-0 top-[53px] z-20 border-b border-line bg-panel p-3 lg:hidden">{items}{status}</div>}
    </>
  );
}
