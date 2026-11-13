import { db } from "@/lib/db";
export const dynamic = "force-dynamic";

/** Owner-only (behind dashboard login): download a product's file to check it. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const f = (await db().query(`SELECT filename, mime, bytes FROM store_assets WHERE product_id = $1 AND role = 'deliverable' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
  if (!f) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": f.mime, "Content-Disposition": `attachment; filename="${f.filename.replace(/"/g, "")}"` } });
}
