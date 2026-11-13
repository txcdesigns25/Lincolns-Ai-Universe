import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import { withTx } from "../db.js";
import { recordProviderEntry } from "../ledger.js";
import { notify } from "../notify.js";
import { audit } from "../audit.js";
import { ShopifyClient, shopifyConfigured } from "./shopify.js";
import { publicBaseUrl } from "./publish.js";

/**
 * Every 15 minutes, no AI involved:
 *  1. Pull new/updated orders from the allowed store.
 *  2. Write verified revenue, refunds, and payment fees into the agent ledger
 *     (idempotent; test orders are recorded as sandbox and never count as real).
 *  3. Deliver: for each paid order containing our products, create a secret
 *     download link and fulfill the order with it (Shopify emails the buyer).
 *     Fully refunded orders get their links revoked.
 *  4. Refresh per-product sales stats and experiment results.
 */
const AGENT = "digital_store";
const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED", "PARTIALLY_PAID"]);
const cents = (m: any) => Math.round(Number(m?.shopMoney?.amount ?? m?.amount ?? 0) * 100);

const ORDERS_QUERY = `query($q: String, $after: String) {
  orders(first: 50, after: $after, sortKey: UPDATED_AT, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name test createdAt updatedAt displayFinancialStatus cancelledAt
      subtotalPriceSet { shopMoney { amount } }
      refunds(first: 20) { id createdAt totalRefundedSet { shopMoney { amount } } }
      transactions(first: 20) { id kind status createdAt fees { amount { amount } } }
      lineItems(first: 30) { nodes { id quantity product { id } discountedTotalSet { shopMoney { amount } } } }
      fulfillmentOrders(first: 5) { nodes { id status } }
    }
  }
}`;

export async function syncStore(db: Db, client = new ShopifyClient(db)): Promise<{ orders: number; delivered: number; skipped?: string }> {
  if (!shopifyConfigured()) return { orders: 0, delivered: 0, skipped: "Shopify not configured" };
  const cursorRow = (await db.query(`SELECT value FROM kv_store WHERE key = 'shopify_orders_cursor'`)).rows[0]?.value;
  let since: string = cursorRow?.updated_at ?? "2026-01-01T00:00:00Z";
  let after: string | null = null, n = 0, delivered = 0, maxUpdated = since;
  for (let page = 0; page < 10; page++) {
    const d: any = await client.query(ORDERS_QUERY, { q: `updated_at:>='${since}'`, after });
    for (const o of d.orders.nodes) {
      await applyOrder(db, o);
      if (o.updatedAt > maxUpdated) maxUpdated = o.updatedAt;
      n++;
      delivered += await deliverOrder(db, client, o);
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  await db.query(`INSERT INTO kv_store (key, value) VALUES ('shopify_orders_cursor', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify({ updated_at: maxUpdated, synced_at: new Date().toISOString() })]);
  await refreshStats(db);
  return { orders: n, delivered };
}

/** Ledger + order snapshot. Exported for tests. */
export async function applyOrder(db: Db, o: any) {
  const ours = new Map<string, string>((await db.query(`SELECT shopify_product_id, id FROM store_products WHERE shopify_product_id IS NOT NULL`)).rows
    .map((r) => [r.shopify_product_id, r.id]));
  const lines = (o.lineItems?.nodes ?? []).map((l: any) => ({ id: l.id, product_id: l.product?.id ?? null, store_product_id: ours.get(l.product?.id) ?? null,
    quantity: l.quantity, total_cents: cents(l.discountedTotalSet) }));
  const paid = PAID.has(o.displayFinancialStatus) && !o.cancelledAt;
  const source = o.test ? "sandbox" : "shopify";
  const refunded = (o.refunds ?? []).reduce((s: number, r: any) => s + cents(r.totalRefundedSet), 0);
  const fees = (o.transactions ?? []).reduce((s: number, t: any) => s + (t.fees ?? []).reduce((a: number, f: any) => a + cents(f.amount), 0), 0);
  await withTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO store_orders (shopify_order_id, name, test, financial_status, subtotal_cents, refunded_cents, fees_cents, line_items, ordered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (shopify_order_id) DO UPDATE SET financial_status = $4, refunded_cents = $6, fees_cents = $7, line_items = $8, synced_at = now()`,
      [o.id, o.name, !!o.test, o.displayFinancialStatus, cents(o.subtotalPriceSet), refunded, fees, JSON.stringify(lines), o.createdAt]);
    if (!paid) return;
    await recordProviderEntry(tx, { agentId: AGENT, type: "revenue", amountCents: cents(o.subtotalPriceSet), source, externalRef: o.id,
      description: `Shopify order ${o.name}`, occurredAt: new Date(o.createdAt) });
    for (const r of o.refunds ?? []) {
      const amt = cents(r.totalRefundedSet);
      if (amt > 0) await recordProviderEntry(tx, { agentId: AGENT, type: "refund", amountCents: amt, source, externalRef: r.id,
        description: `Refund on ${o.name}`, occurredAt: new Date(r.createdAt) });
    }
    for (const t of o.transactions ?? []) {
      const fee = (t.fees ?? []).reduce((a: number, f: any) => a + cents(f.amount), 0);
      if (fee > 0) await recordProviderEntry(tx, { agentId: AGENT, type: "processing_fee", amountCents: fee, source, externalRef: t.id,
        description: `Payment fee on ${o.name}`, occurredAt: new Date(t.createdAt) });
    }
    if (o.displayFinancialStatus === "REFUNDED") {
      await tx.query(`UPDATE store_deliveries SET revoked = TRUE WHERE shopify_order_id = $1`, [o.id]);
    }
  });
}

async function deliverOrder(db: Db, client: ShopifyClient, o: any): Promise<number> {
  if (!PAID.has(o.displayFinancialStatus) || o.displayFinancialStatus === "REFUNDED" || o.cancelledAt) return 0;
  const lines = (await db.query(`SELECT line_items FROM store_orders WHERE shopify_order_id = $1`, [o.id])).rows[0]?.line_items ?? [];
  const productIds = [...new Set(lines.map((l: any) => l.store_product_id).filter(Boolean))] as string[];
  if (!productIds.length) return 0;
  const links: { title: string; url: string }[] = [];
  for (const pid of productIds) {
    const row = (await db.query(
      `INSERT INTO store_deliveries (shopify_order_id, product_id, token) VALUES ($1,$2,$3)
       ON CONFLICT (shopify_order_id, product_id) DO UPDATE SET product_id = EXCLUDED.product_id
       RETURNING token, fulfilled_at, (SELECT title FROM store_products WHERE id = $2) AS title`,
      [o.id, pid, randomBytes(24).toString("base64url")])).rows[0];
    if (!row.fulfilled_at) links.push({ title: row.title, url: `${publicBaseUrl()}/d/${row.token}` });
  }
  if (!links.length) return 0;
  const open = (o.fulfillmentOrders?.nodes ?? []).filter((f: any) => ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(f.status));
  if (!open.length) return 0;
  try {
    // Shopify's shipping-confirmation email carries the link as the "tracking" URL.
    // The download page lists every file in the order, so one link covers all.
    const url = links[0].url;
    await client.mutate(
      `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }`,
      { fulfillment: { notifyCustomer: true, lineItemsByFulfillmentOrder: open.map((f: any) => ({ fulfillmentOrderId: f.id })),
        trackingInfo: { company: "Instant download", number: o.name, url } } }, "fulfillmentCreate");
    await db.query(`UPDATE store_deliveries SET fulfilled_at = now(), fulfill_error = NULL WHERE shopify_order_id = $1`, [o.id]);
    await audit(db, { actor: "store_sync", agentId: AGENT, action: "store.deliver", outcome: "allowed", details: { order: o.name, products: productIds.length } });
    return 1;
  } catch (e: any) {
    await db.query(`UPDATE store_deliveries SET fulfill_error = $2 WHERE shopify_order_id = $1`, [o.id, String(e?.message ?? e).slice(0, 1000)]);
    await notify(db, { severity: "warning", agentId: AGENT, title: `Could not deliver order ${o.name}`, body: String(e?.message ?? e).slice(0, 400), dedupeKey: `deliver:${o.id}` });
    return 0;
  }
}

/** Per-product sales and experiment results from real (non-test) orders. */
export async function refreshStats(db: Db) {
  await db.query(`
    WITH li AS (
      SELECT (l->>'store_product_id')::uuid AS pid, (l->>'quantity')::int AS qty, (l->>'total_cents')::bigint AS total, o.financial_status
        FROM store_orders o, jsonb_array_elements(o.line_items) l
       WHERE NOT o.test AND l->>'store_product_id' IS NOT NULL AND o.financial_status IN ('PAID','PARTIALLY_REFUNDED','REFUNDED','PARTIALLY_PAID'))
    UPDATE store_products p SET units_sold = s.units, revenue_cents = s.revenue, refunds = s.refunds, updated_at = now()
      FROM (SELECT pid, SUM(qty)::int AS units, SUM(total)::bigint AS revenue, COUNT(*) FILTER (WHERE financial_status = 'REFUNDED')::int AS refunds FROM li GROUP BY pid) s
     WHERE p.id = s.pid`);
  // Experiments: conversions = units sold per variant (trials need storefront analytics; see docs).
  const exps = (await db.query(`SELECT DISTINCT experiment_id FROM store_products WHERE experiment_id IS NOT NULL`)).rows;
  for (const { experiment_id } of exps) {
    const ex = (await db.query(`SELECT results, status FROM experiments WHERE id = $1`, [experiment_id])).rows[0];
    if (!ex || ex.status === "concluded" || ex.status === "abandoned") continue;
    const per = (await db.query(`SELECT experiment_variant AS v, SUM(units_sold)::int AS units, SUM(revenue_cents)::bigint AS revenue
                                  FROM store_products WHERE experiment_id = $1 GROUP BY experiment_variant`, [experiment_id])).rows;
    const results = { ...ex.results };
    for (const r of per) if (r.v) results[r.v] = { ...(results[r.v] ?? { trials: 0 }), conversions: r.units, revenue_cents: Number(r.revenue) };
    await db.query(`UPDATE experiments SET results = $2, status = CASE WHEN status = 'proposed' THEN 'running' ELSE status END WHERE id = $1`,
      [experiment_id, JSON.stringify(results)]);
  }
}
