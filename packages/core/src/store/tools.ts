import { z } from "zod";
import type { Queryable } from "../db.js";
import type { ToolSpec } from "../tools/index.js";
import { PolicyDenied } from "../errors.js";
import type { DraftForExecution, ExecutionResult } from "../integrations.js";
import { SpreadsheetSpec, PlannerSpec } from "./specs.js";

// Renderers use native modules; load them only where products are built (the
// worker), never in the dashboard bundle.
const loadRenderers = (): Promise<typeof import("./products.js")> => import(/* webpackIgnore: true */ "./products" + ".js");
import { ShopifyClient, shopifyConfigured } from "./shopify.js";
import { applyBranding, getBrand, publishStoreProduct, updateStoreProduct, MIN_PRICE_CENTS, MAX_PRICE_CENTS } from "./publish.js";

/** Agent tools for the Digital Product Store. Building is internal; going live is a queued, gated action. */

export const MAX_NEW_PRODUCTS_PER_DAY = Number(process.env.STORE_MAX_NEW_PRODUCTS_PER_DAY ?? 3);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const usd = z.number().min(MIN_PRICE_CENTS / 100).max(MAX_PRICE_CENTS / 100);

const BrandInput = z.object({
  name: z.string().min(2).max(40).describe("New store brand name you chose. Original; not a known brand or trademark."),
  tagline: z.string().min(5).max(120),
  niche: z.string().min(3).max(200).describe("Who the store serves and what problem it solves"),
  about_html: z.string().min(50).max(5000).describe("About page HTML. Honest: no fake founders, reviews, or claims."),
  collection_title: z.string().min(3).max(60),
  accent: hex, background: hex,
  rationale: z.string().min(20).max(2000).describe("Why this niche: evidence and reasoning; recorded so you can learn from the outcome"),
});

const ListingInput = z.object({
  title: z.string().min(5).max(120),
  description_html: z.string().min(100).max(8000).describe("Benefit-led, honest description; say exactly what file(s) the buyer gets and that delivery is an instant download link by email"),
  price_usd: usd,
  compare_at_usd: usd.optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
});

async function newProductsToday(q: Queryable) {
  return (await q.query(`SELECT count(*)::int AS n FROM store_products WHERE created_at > now() - interval '1 day'`)).rows[0].n as number;
}

export const STORE_TOOLS: ToolSpec[] = [
  {
    name: "get_store_status",
    description: "Your Shopify store at a glance: connection, current brand, every product with units sold / revenue / refunds, recent orders, deliveries with problems, and pending store changes. Use it at the start of every cycle.",
    action: "report.financial",
    schema: z.object({}),
    handler: async (ctx) => {
      const [brand, products, orders, pending, problems, pinned] = await Promise.all([
        getBrand(ctx.db),
        ctx.db.query(`SELECT id, kind, niche, title, status, (listing->>'price_cents')::int AS price_cents, units_sold, revenue_cents, refunds,
                             shopify_handle, experiment_id, experiment_variant, created_at, published_at FROM store_products ORDER BY created_at DESC LIMIT 40`),
        ctx.db.query(`SELECT count(*) FILTER (WHERE NOT test)::int AS real_orders, count(*) FILTER (WHERE test)::int AS test_orders,
                             COALESCE(SUM(subtotal_cents) FILTER (WHERE NOT test),0)::bigint AS revenue_cents,
                             COALESCE(SUM(refunded_cents) FILTER (WHERE NOT test),0)::bigint AS refunded_cents
                        FROM store_orders WHERE ordered_at > now() - interval '30 days'`),
        ctx.db.query(`SELECT id, draft_type, title, status FROM drafts WHERE agent_id = $1 AND draft_type IN ('store_product','store_branding') AND status IN ('draft','pending_approval','approved') ORDER BY created_at DESC LIMIT 20`, [ctx.agentId]),
        ctx.db.query(`SELECT shopify_order_id, fulfill_error FROM store_deliveries WHERE fulfilled_at IS NULL AND fulfill_error IS NOT NULL LIMIT 10`),
        ctx.db.query(`SELECT value FROM kv_store WHERE key = 'shopify_pinned_shop'`),
      ]);
      const live = (await ctx.db.query(`SELECT live_mode FROM agents WHERE id = $1`, [ctx.agentId])).rows[0]?.live_mode;
      return {
        shopify_connected: shopifyConfigured(), live_mode: !!live, pinned_store: pinned.rows[0]?.value ?? null,
        note: !live ? "Sandbox mode: store changes are simulated until the owner turns on live mode." : undefined,
        brand, products: products.rows, last_30_days: orders.rows[0], pending_store_changes: pending.rows, delivery_problems: problems.rows,
        new_products_today: await newProductsToday(ctx.db), max_new_products_per_day: MAX_NEW_PRODUCTS_PER_DAY,
      };
    },
  },
  {
    name: "set_store_brand",
    description: "Choose or change the store's brand and niche (name, tagline, About page, colors). Creates a store_branding draft; then call submit_draft to apply it. Rebranding resets audience trust, so only change an existing brand with evidence.",
    action: "draft.create",
    schema: BrandInput,
    handler: async (ctx, i: any) => {
      const r = await ctx.db.query(`INSERT INTO drafts (agent_id, draft_type, title, body, metadata, task_id) VALUES ($1,'store_branding',$2,$3,$4,$5) RETURNING id`,
        [ctx.agentId, `Brand: ${i.name}`, i.about_html, JSON.stringify({ op: "brand", brand: i }), ctx.taskId]);
      return { draft_id: r.rows[0].id, next: "Call submit_draft with this draft_id to apply it to the store." };
    },
  },
  {
    name: "build_digital_product",
    description: "Design and build an ORIGINAL digital product: an Excel spreadsheet (kind=spreadsheet, give `spreadsheet`) or a printable PDF planner (kind=planner, give `planner`). The platform renders the real file plus two listing images, and creates a store_product draft; call submit_draft to put it on sale. Do not copy others' products or use trademarks.",
    action: "draft.create",
    schema: z.object({
      kind: z.enum(["spreadsheet", "planner"]),
      niche: z.string().min(3).max(200),
      title: z.string().min(5).max(100).describe("Product name, also used on the file"),
      spreadsheet: SpreadsheetSpec.optional(),
      planner: PlannerSpec.optional(),
      listing: ListingInput,
      cover: z.object({ headline: z.string().min(3).max(60), subhead: z.string().max(120).optional(), badge: z.string().min(2).max(24).describe("e.g. 'Excel + Google Sheets'") }),
      experiment_id: z.string().uuid().optional(),
      experiment_variant: z.string().max(40).optional(),
    }),
    handler: async (ctx, i: any) => {
      if ((await newProductsToday(ctx.db)) >= MAX_NEW_PRODUCTS_PER_DAY)
        throw new PolicyDenied("daily_product_limit", `At most ${MAX_NEW_PRODUCTS_PER_DAY} new products per day; improve existing ones instead`);
      const spec = i.kind === "spreadsheet" ? i.spreadsheet : i.planner;
      if (!spec) throw new PolicyDenied("invalid_input", `kind=${i.kind} requires the '${i.kind}' field`);
      if (i.listing.compare_at_usd && i.listing.compare_at_usd <= i.listing.price_usd) throw new PolicyDenied("invalid_input", "compare_at_usd must be above price_usd");
      const { renderSpreadsheet, renderPlanner, coverSvg, renderPng } = await loadRenderers();
      const brand = await getBrand(ctx.db);
      const brandName = brand?.name ?? "Digital Store";
      const file = i.kind === "spreadsheet" ? await renderSpreadsheet(i.title, spec, brandName) : await renderPlanner(i.title, spec, brandName);
      const preview: string[] = i.kind === "spreadsheet" ? spec.sheets.map((s: any) => s.name) : spec.pages.map((p: any) => p.title);
      const colors = { accent: brand?.accent ?? spec.accent_color ?? "#2563EB", background: brand?.background ?? "#F8FAFC" };
      const cover = renderPng(coverSvg({ brand: brandName, headline: i.cover.headline, subhead: i.cover.subhead, badge: i.cover.badge, kind: i.kind, preview, ...colors }));
      const detailList = i.kind === "spreadsheet" ? spec.sheets.flatMap((s: any) => s.columns.slice(0, 3).map((c: any) => `${s.name}: ${c.header}`)) : preview;
      const second = renderPng(coverSvg({ brand: brandName, headline: "What's inside", subhead: i.title, badge: i.cover.badge, kind: i.kind, preview: detailList, ...colors }));
      const listing = { title: i.listing.title, description_html: i.listing.description_html, price_cents: Math.round(i.listing.price_usd * 100),
        compare_at_cents: i.listing.compare_at_usd ? Math.round(i.listing.compare_at_usd * 100) : null, tags: i.listing.tags ?? [] };
      const ext = i.kind === "spreadsheet" ? "xlsx" : "pdf";
      const mime = i.kind === "spreadsheet" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
      const filename = `${i.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.${ext}`;
      const p = (await ctx.db.query(
        `INSERT INTO store_products (agent_id, kind, niche, title, spec, listing, experiment_id, experiment_variant) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.agentId, i.kind, i.niche, i.title, JSON.stringify(spec), JSON.stringify(listing), i.experiment_id ?? null, i.experiment_variant ?? null])).rows[0];
      for (const [role, fn, m, bytes] of [["deliverable", filename, mime, file], ["cover", "cover.png", "image/png", cover], ["preview", "inside.png", "image/png", second]] as const) {
        await ctx.db.query(`INSERT INTO store_assets (product_id, role, filename, mime, bytes, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`, [p.id, role, fn, m, bytes, bytes.length]);
      }
      const d = (await ctx.db.query(`INSERT INTO drafts (agent_id, draft_type, title, body, metadata, experiment_id, task_id) VALUES ($1,'store_product',$2,$3,$4,$5,$6) RETURNING id`,
        [ctx.agentId, listing.title, listing.description_html, JSON.stringify({ op: "create", product_id: p.id }), i.experiment_id ?? null, ctx.taskId])).rows[0];
      await ctx.db.query(`UPDATE store_products SET draft_id = $2 WHERE id = $1`, [p.id, d.id]);
      return { product_id: p.id, draft_id: d.id, file: { filename, bytes: file.length }, images: 2,
        next: "Review the listing, then call submit_draft with draft_id to put it on sale." };
    },
  },
  {
    name: "change_store_product",
    description: "Change a product that is already on the store: new price (within $3-$99), title, description, or archive it. Creates a store_product draft; call submit_draft to apply. Record why, so the result can be learned from.",
    action: "draft.create",
    schema: z.object({
      product_id: z.string().uuid(),
      price_usd: usd.optional(),
      title: z.string().min(5).max(120).optional(),
      description_html: z.string().min(100).max(8000).optional(),
      archive: z.boolean().optional(),
      reason: z.string().min(10).max(1000),
    }),
    handler: async (ctx, i: any) => {
      const p = (await ctx.db.query(`SELECT title, shopify_product_id FROM store_products WHERE id = $1 AND agent_id = $2`, [i.product_id, ctx.agentId])).rows[0];
      if (!p) throw new PolicyDenied("not_found", "Product not found");
      const change = { price_cents: i.price_usd ? Math.round(i.price_usd * 100) : undefined, title: i.title, description_html: i.description_html, archive: i.archive };
      if (!Object.values(change).some((v) => v !== undefined)) throw new PolicyDenied("invalid_input", "Nothing to change");
      const d = (await ctx.db.query(`INSERT INTO drafts (agent_id, draft_type, title, body, metadata, task_id) VALUES ($1,'store_product',$2,$3,$4,$5) RETURNING id`,
        [ctx.agentId, `Change: ${p.title}`, i.reason, JSON.stringify({ op: "update", product_id: i.product_id, change }), ctx.taskId])).rows[0];
      return { draft_id: d.id, next: "Call submit_draft with this draft_id to apply it." };
    },
  },
];

/** Executor for store drafts (store.publish_owned). Runs from the queue only. */
export async function executeStoreDraft(db: Queryable, d: DraftForExecution): Promise<ExecutionResult> {
  const c = new ShopifyClient(db);
  const m = d.metadata ?? {};
  if (d.draft_type === "store_branding" && m.op === "brand") return { sandbox: false, ...(await applyBranding(db, c, m.brand)) };
  if (d.draft_type === "store_product" && m.op === "create") return { sandbox: false, ...(await publishStoreProduct(db, c, m.product_id)) };
  if (d.draft_type === "store_product" && m.op === "update") return { sandbox: false, ...(await updateStoreProduct(db, c, m.product_id, m.change)) };
  throw new PolicyDenied("not_publishable", `No store executor for ${d.draft_type}/${m.op}`);
}
