import { db } from "@/lib/db";
export const dynamic = "force-dynamic";

/** Public listing images (Shopify fetches these). Never serves the paid files. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id.replace(/\.png$/, "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const a = (await db().query(`SELECT bytes, mime FROM store_assets WHERE id = $1 AND role IN ('cover','preview')`, [id])).rows[0];
  if (!a) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(a.bytes), { headers: { "Content-Type": a.mime, "Cache-Control": "public, max-age=86400" } });
}
