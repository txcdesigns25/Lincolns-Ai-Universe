import { db } from "@/lib/db";
import { Card, PageHeader, Table, Badge, Money, Stat, Button } from "@/components/ui";
import { setLiveMode } from "../../actions";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function StorePage() {
  const q = db();
  const [kv, agent, products, orders, totals, drafts] = await Promise.all([
    q.query(`SELECT key, value, updated_at FROM kv_store WHERE key IN ('store_brand','shopify_pinned_shop','shopify_orders_cursor','worker_config')`).then((r) => Object.fromEntries(r.rows.map((x) => [x.key, x.value]))),
    q.query(`SELECT status, live_mode FROM agents WHERE id = 'digital_store'`).then((r) => r.rows[0]),
    q.query(`SELECT p.*, (SELECT id FROM store_assets a WHERE a.product_id = p.id AND a.role = 'cover' LIMIT 1) AS cover_id FROM store_products p ORDER BY p.created_at DESC LIMIT 50`).then((r) => r.rows),
    q.query(`SELECT o.*, (SELECT bool_and(d.fulfilled_at IS NOT NULL) FROM store_deliveries d WHERE d.shopify_order_id = o.shopify_order_id) AS delivered,
                    (SELECT max(d.fulfill_error) FROM store_deliveries d WHERE d.shopify_order_id = o.shopify_order_id) AS err
               FROM store_orders o ORDER BY ordered_at DESC LIMIT 25`).then((r) => r.rows),
    q.query(`SELECT COALESCE(SUM(subtotal_cents) FILTER (WHERE NOT test),0)::bigint AS revenue, COALESCE(SUM(refunded_cents) FILTER (WHERE NOT test),0)::bigint AS refunds,
                    COALESCE(SUM(fees_cents) FILTER (WHERE NOT test),0)::bigint AS fees, count(*) FILTER (WHERE NOT test)::int AS n FROM store_orders`).then((r) => r.rows[0]),
    q.query(`SELECT id, draft_type, title, status, created_at FROM drafts WHERE draft_type IN ('store_product','store_branding') ORDER BY created_at DESC LIMIT 15`).then((r) => r.rows),
  ]);
  const brand = kv.store_brand, pinned = kv.shopify_pinned_shop, wc = kv.worker_config ?? {};
  const shopUrl = pinned?.myshopifyDomain ? `https://${pinned.myshopifyDomain}` : null;
  return (
    <>
      <PageHeader title="Digital Product Store" subtitle="Agent 01 runs this store on its own: niche, brand, products, prices. Only the one allowed Shopify store can be written to." />
      {!agent?.live_mode ? (
        <Card title="Go live" className="mb-4">
          <p className="text-sm text-muted">The agent is in sandbox mode: it designs a brand and products, but nothing reaches Shopify. Turn on live mode to let it run the store for real. Anything it designed in sandbox is then published automatically.</p>
          <form action={setLiveMode} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="agent_id" value="digital_store" /><input type="hidden" name="live" value="true" />
            <input name="confirm" placeholder="Type LIVE" className="w-32" />
            <Button tone="danger">Enable live mode</Button>
          </form>
        </Card>
      ) : null}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Real orders" value={totals.n} />
        <Stat label="Revenue" value={<Money cents={Number(totals.revenue)} />} hint="Shopify, excludes test orders" />
        <Stat label="Refunds" value={<Money cents={Number(totals.refunds)} />} tone={Number(totals.refunds) ? "warn" : undefined} />
        <Stat label="Payment fees" value={<Money cents={Number(totals.fees)} />} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Brand">
          {brand ? (
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-4"><dt className="text-muted">Name</dt><dd className="font-medium">{brand.name} {brand.sandbox && <Badge tone="paused">sandbox</Badge>}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Tagline</dt><dd className="text-right">{brand.tagline}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Niche</dt><dd className="text-right">{brand.niche}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Chosen</dt><dd>{ago(brand.applied_at)}</dd></div>
            </dl>
          ) : <p className="text-sm text-faint">The agent has not chosen a brand yet. It does this on its first growth cycle.</p>}
        </Card>
        <Card title="Connection">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Shopify configured on worker</dt><dd><Badge tone={wc.shopify ? "active" : "x"}>{wc.shopify ? "yes" : "no"}</Badge></dd></div>
            <div className="flex justify-between"><dt className="text-muted">Allowed store</dt><dd><code className="text-xs">{wc.shopifyStore ?? "not set"}</code></dd></div>
            <div className="flex justify-between"><dt className="text-muted">Verified and locked to</dt><dd>{shopUrl ? <a className="underline" href={`${shopUrl}/admin`} target="_blank">{pinned.myshopifyDomain}</a> : <span className="text-faint">not yet</span>}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Agent</dt><dd><Badge>{agent?.status}</Badge> {agent?.live_mode ? <Badge tone="active">live</Badge> : <Badge tone="paused">sandbox</Badge>}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Last order sync</dt><dd>{ago(kv.shopify_orders_cursor?.synced_at)}</dd></div>
          </dl>
          {agent?.live_mode && (
            <form action={setLiveMode} className="mt-3">
              <input type="hidden" name="agent_id" value="digital_store" /><input type="hidden" name="live" value="false" />
              <Button>Switch back to sandbox</Button>
            </form>
          )}
        </Card>
      </div>
      <Card title="Products" className="mt-4">
        <Table empty="No products yet." head={["", "Product", "Price", "Status", "Sold", "Revenue", "Refunds", ""]} rows={products.map((p) => [
          p.cover_id ? <img key="i" src={`/api/store/assets/${p.cover_id}.png`} alt="" className="h-12 w-12 rounded-md object-cover" /> : null,
          <div key="t"><div>{p.title}</div><div className="text-xs text-muted">{p.kind} · {p.niche}{p.experiment_variant ? ` · test variant ${p.experiment_variant}` : ""}</div></div>,
          <Money key="p" cents={p.listing.price_cents} />, <Badge key="s" tone={p.status === "published" ? "active" : p.status === "archived" ? "x" : "pending"}>{p.status}</Badge>,
          p.units_sold, <Money key="r" cents={Number(p.revenue_cents)} />, p.refunds,
          <div key="l" className="flex gap-2 text-xs"><a className="underline" href={`/api/store/files/${p.id}`}>file</a>{shopUrl && p.shopify_handle && <a className="underline" href={`${shopUrl}/products/${p.shopify_handle}`} target="_blank">view</a>}</div>,
        ])} />
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Recent orders">
          <Table empty="No orders yet." head={["Order", "When", "Subtotal", "Status", "Delivery"]} rows={orders.map((o) => [
            <span key="n">{o.name} {o.test && <Badge tone="paused">test</Badge>}</span>, ago(o.ordered_at), <Money key="m" cents={Number(o.subtotal_cents)} />,
            <Badge key="s">{String(o.financial_status).toLowerCase()}</Badge>,
            o.err ? <span key="d" className="text-xs text-bad" title={o.err}>failed</span> : o.delivered ? <Badge key="d" tone="active">sent</Badge> : <span key="d" className="text-xs text-muted">n/a</span>,
          ])} />
        </Card>
        <Card title="Store changes by the agent">
          <Table empty="None yet." head={["Change", "Status", "When"]} rows={drafts.map((d) => [d.title, <Badge key="s">{d.status}</Badge>, ago(d.created_at)])} />
        </Card>
      </div>
    </>
  );
}
