import { Nav } from "@/components/nav";
import { db } from "@/lib/db";
import { emergencyRelease, logout } from "../actions";

export const dynamic = "force-dynamic";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  const [controls, pending, worker, notes] = await Promise.all([
    db().query(`SELECT emergency_stop, stop_reason FROM system_controls WHERE id`),
    db().query(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'`),
    db().query(`SELECT max(last_heartbeat) > now() - interval '2 minutes' AS online FROM workers`),
    db().query(`SELECT count(*)::int AS n FROM notifications WHERE NOT acknowledged AND severity <> 'info'`),
  ]);
  const stopped = controls.rows[0]?.emergency_stop;
  return (
    <div className="lg:flex">
      <Nav pending={pending.rows[0].n} workerOnline={!!worker.rows[0].online} />
      <div className="min-w-0 flex-1">
        {stopped && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-bad/40 bg-bad/10 px-4 py-2 text-sm text-bad lg:px-8">
            <span><strong>Emergency stop engaged.</strong> All agent spending and external actions are blocked. {controls.rows[0].stop_reason}</span>
            <form action={emergencyRelease}><button className="rounded-md border border-bad/40 px-2 py-0.5 text-xs">Release</button></form>
          </div>
        )}
        {notes.rows[0].n > 0 && (
          <a href="/settings#notifications" className="block border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-warn lg:px-8">
            {notes.rows[0].n} notification(s) need your attention
          </a>
        )}
        <main className="mx-auto max-w-7xl px-4 py-6 lg:px-8">{children}</main>
        <footer className="mx-auto flex max-w-7xl justify-end px-4 pb-6 lg:px-8">
          <form action={logout}><button className="text-xs text-faint hover:text-muted">Sign out</button></form>
        </footer>
      </div>
    </div>
  );
}
