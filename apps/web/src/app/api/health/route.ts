import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  const r = await db().query(`SELECT max(last_heartbeat) > now() - interval '2 minutes' AS worker FROM workers`);
  return Response.json({ ok: true, worker_online: !!r.rows[0].worker });
}
