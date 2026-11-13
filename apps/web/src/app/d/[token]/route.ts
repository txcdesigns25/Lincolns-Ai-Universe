import { db } from "@/lib/db";
export const dynamic = "force-dynamic";

const MAX_DOWNLOADS = 25;
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

/**
 * Buyer download page. The secret token comes from the order's delivery email.
 * Lists every file in that order; ?download=1 streams one file. Links stop
 * working if the order is refunded or after 25 downloads.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return page("Link not found", "<p>This download link is not valid.</p>", 404);
  const q = db();
  const d = (await q.query(`SELECT d.*, p.title FROM store_deliveries d JOIN store_products p ON p.id = d.product_id WHERE d.token = $1`, [token])).rows[0];
  if (!d) return page("Link not found", "<p>This download link is not valid.</p>", 404);
  if (d.revoked) return page("Link no longer active", "<p>This order was refunded, so the download is no longer available.</p>", 410);

  if (new URL(req.url).searchParams.get("download") === "1") {
    if (d.downloads >= MAX_DOWNLOADS) return page("Download limit reached", "<p>Please reply to your order email if you need help.</p>", 429);
    const f = (await q.query(`SELECT filename, mime, bytes FROM store_assets WHERE product_id = $1 AND role = 'deliverable' ORDER BY created_at DESC LIMIT 1`, [d.product_id])).rows[0];
    if (!f) return page("File missing", "<p>Please reply to your order email and we will fix this quickly.</p>", 404);
    await q.query(`UPDATE store_deliveries SET downloads = downloads + 1 WHERE id = $1`, [d.id]);
    return new Response(new Uint8Array(f.bytes), { headers: { "Content-Type": f.mime, "Content-Disposition": `attachment; filename="${f.filename.replace(/"/g, "")}"`, "Cache-Control": "no-store" } });
  }

  const all = (await q.query(`SELECT d.token, p.title, d.revoked FROM store_deliveries d JOIN store_products p ON p.id = d.product_id WHERE d.shopify_order_id = $1 ORDER BY p.title`, [d.shopify_order_id])).rows;
  const brand = (await q.query(`SELECT value FROM kv_store WHERE key = 'store_brand'`)).rows[0]?.value?.name ?? "Your order";
  const items = all.filter((x) => !x.revoked).map((x) => `<li><span>${esc(x.title)}</span><a href="/d/${x.token}?download=1">Download</a></li>`).join("");
  return page(`${esc(brand)}: your downloads`, `<p>Thanks for your purchase! Your files are below.</p><ul>${items}</ul><p class="s">Save the files to your device. Spreadsheets open in Excel, Google Sheets (File &gt; Import), or Numbers.</p>`);
}

function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#111;background:#fafafa}h1{font-size:22px}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:14px;margin:8px 0}a{background:#111;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;white-space:nowrap}.s{color:#666;font-size:14px}</style></head>
<body><h1>${title}</h1>${body}</body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
