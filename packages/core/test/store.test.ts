import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  checkConfig, checkIdentity, isBlockedStore, ShopifyClient, applyOrder, syncStore, promoteSandboxDrafts, runTask, claimNext, AGENT_BY_ID, type Db,
} from "../src/index.js";
import { executeTool } from "../src/tools/index.js";
import { renderSpreadsheet, renderPlanner, coverSvg, renderPng } from "../src/store/products.js";
import { freshDb, setLimits } from "./helpers.js";

const APEX = "apex-motorsports-test.myshopify.com";
const big = { starting_budget: 1_000_000, daily_limit: 1_000_000, weekly_limit: 1_000_000, monthly_limit: 1_000_000, per_transaction_limit: 1_000_000, ai_monthly_limit: 1_000_000 };

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await db.query(`UPDATE schedules SET enabled = FALSE`);
  await setLimits(db, "digital_store", big);
});
afterAll(async () => { await db.end(); });
beforeEach(() => {
  process.env.SHOPIFY_STORE_DOMAIN = APEX;
  process.env.SHOPIFY_ALLOWED_STORE = APEX;
  process.env.SHOPIFY_ADMIN_TOKEN = "shpat_test";
  process.env.PUBLIC_BASE_URL = "https://universe.example";
});

/** A fake Shopify: answers the shop query with `shop`, records every mutation. */
function fakeShopify(shop: any, handlers: Record<string, (vars: any) => any> = {}) {
  const calls: { query: string; variables: any }[] = [];
  const f = (async (_url: any, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    if (query.includes("shop {")) return Response.json({ data: { shop } });
    for (const [k, h] of Object.entries(handlers)) if (query.includes(k)) return Response.json({ data: h(variables) });
    return Response.json({ data: {} });
  }) as typeof fetch;
  return { f, calls, mutations: () => calls.filter((c) => /^\s*mutation/.test(c.query)) };
}

describe("store guard (pure)", () => {
  it("refuses every non-Apex store on the owner's account", () => {
    for (const s of [{ name: "TXC Designs" }, { primaryHost: "txcdesigns.com" }, { myshopifyDomain: "cmr0ny-mc.myshopify.com" },
      { name: "TXC Powersports" }, { myshopifyDomain: "burning-albatross-r3dzi7.myshopify.com" }]) expect(isBlockedStore(s)).toBe(true);
    expect(isBlockedStore({ name: "Apex Motorsports", myshopifyDomain: APEX })).toBe(false);
  });

  it("requires an allowlist and an exact domain match", () => {
    expect(checkConfig({ storeDomain: APEX, allowedStore: "" }).ok).toBe(false);
    expect(checkConfig({ storeDomain: "cmr0ny-mc.myshopify.com", allowedStore: APEX }).ok).toBe(false);
    expect(checkConfig({ storeDomain: "cmr0ny-mc.myshopify.com", allowedStore: "cmr0ny-mc.myshopify.com" }).ok).toBe(false); // blocklist wins
    expect(checkConfig({ storeDomain: "apex.com", allowedStore: "apex.com" }).ok).toBe(false); // must be myshopify domain
    expect(checkConfig({ storeDomain: `https://${APEX}/`, allowedStore: APEX.toUpperCase() }).ok).toBe(true);
  });

  it("checks the live identity, not the (changeable) store name", () => {
    expect(checkIdentity({ id: "gid://shopify/Shop/1", name: "Brand New Name", myshopifyDomain: APEX }, { allowedStore: APEX }).ok).toBe(true);
    expect(checkIdentity({ name: "Apex Motorsports", myshopifyDomain: "cmr0ny-mc.myshopify.com" }, { allowedStore: APEX }).ok).toBe(false);
    expect(checkIdentity(null, { allowedStore: APEX }).ok).toBe(false);
    expect(checkIdentity({ id: "gid://shopify/Shop/2", myshopifyDomain: APEX }, { allowedStore: APEX, pinnedShopId: "gid://shopify/Shop/1" }).ok).toBe(false);
  });
});

describe("Shopify client write guard", () => {
  it("refuses to write when the token belongs to TXC Designs, and sends no mutation", async () => {
    const s = fakeShopify({ id: "gid://shopify/Shop/9", name: "TXC Designs", myshopifyDomain: "cmr0ny-mc.myshopify.com" });
    const c = new ShopifyClient(db, s.f);
    await expect(c.mutate(`mutation { productCreate(product: {title: "x"}) { userErrors { message } } }`, {}, "productCreate")).rejects.toMatchObject({ code: "store_guard" });
    expect(s.mutations()).toHaveLength(0);
  });

  it("refuses when env points at another store, before calling Shopify at all", async () => {
    process.env.SHOPIFY_STORE_DOMAIN = "cmr0ny-mc.myshopify.com";
    const s = fakeShopify({});
    await expect(new ShopifyClient(db, s.f).shop()).rejects.toMatchObject({ code: "store_guard" });
    expect(s.calls).toHaveLength(0);
  });

  it("writes to Apex, pins its shop id, then refuses a different shop at the same domain", async () => {
    const ok = fakeShopify({ id: "gid://shopify/Shop/1", name: "Apex Motorsports", myshopifyDomain: APEX }, { productCreate: () => ({ productCreate: { product: { id: "p1" }, userErrors: [] } }) });
    const out = await new ShopifyClient(db, ok.f).mutate(`mutation { productCreate(product: {title: "x"}) { product { id } userErrors { message } } }`, {}, "productCreate");
    expect(out.product.id).toBe("p1");
    const pin = (await db.query(`SELECT value FROM kv_store WHERE key = 'shopify_pinned_shop'`)).rows[0].value;
    expect(pin.id).toBe("gid://shopify/Shop/1");
    const other = fakeShopify({ id: "gid://shopify/Shop/2", name: "Apex", myshopifyDomain: APEX });
    await expect(new ShopifyClient(db, other.f).mutate(`mutation { x { userErrors { message } } }`, {}, "x")).rejects.toMatchObject({ code: "store_guard" });
    expect(other.mutations()).toHaveLength(0);
  });

  it("query() rejects mutations", async () => {
    const s = fakeShopify({});
    await expect(new ShopifyClient(db, s.f).query(`mutation { x }`)).rejects.toMatchObject({ code: "store_guard" });
  });
});

describe("product files", () => {
  it("renders a real xlsx, pdf, and png", async () => {
    const xlsx = await renderSpreadsheet("Budget", { instructions: "Fill in.", sheets: [{ name: "Monthly", columns: [{ header: "Item" }, { header: "Amount", format: "currency" }],
      rows: [["Rent", 1200], ["Total", "=SUM(B2:B2)"]], blank_rows: 5 }] }, "Brand");
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    const pdf = await renderPlanner("Planner", { pages: [{ title: "Week", repeat: 2, blocks: [{ type: "checklist", items: ["a"], count: 2 }, { type: "grid", columns: ["Day", "Task"], rows: 3 }, { type: "lines", count: 3 }] }] }, "Brand");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const png = renderPng(coverSvg({ brand: "B & co", headline: "A <great> sheet", badge: "Excel", accent: "#2563EB", background: "#FFFFFF", preview: ["One"], kind: "spreadsheet" }));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});

const spreadsheetProduct = {
  kind: "spreadsheet", niche: "freelance designers tracking invoices", title: "Freelance Invoice Tracker",
  spreadsheet: { instructions: "Add each invoice as a row.", sheets: [{ name: "Invoices", columns: [{ header: "Client" }, { header: "Amount", format: "currency" }, { header: "Paid", format: "checkbox" }], rows: [["Acme", 500, "✓"]], blank_rows: 20 }] },
  listing: { title: "Freelance Invoice Tracker (Excel)", description_html: "<p>" + "Track every invoice, see what is overdue, and know your monthly income at a glance. ".repeat(2) + "</p>", price_usd: 9 },
  cover: { headline: "Invoice Tracker", subhead: "For freelancers", badge: "Excel + Sheets" },
};

describe("agent store workflow", () => {
  const tools = AGENT_BY_ID.digital_store.tools;
  const ctx = (taskId: string) => ({ db, agentId: "digital_store", taskId });
  let taskId: string;
  beforeAll(async () => {
    taskId = (await db.query(`INSERT INTO tasks (agent_id, type, title) VALUES ('digital_store','growth_cycle','t') RETURNING id`)).rows[0].id;
  });

  it("brand + product: built internally, publish queued without approval (owner's standing grant), sandbox while not live", async () => {
    const b = await executeTool(ctx(taskId), tools, "set_store_brand", { name: "Ledgerly", tagline: "Simple money sheets for freelancers", niche: "freelancers",
      about_html: "<p>Ledgerly makes simple, honest spreadsheet tools for freelancers who want clear numbers.</p>", collection_title: "All tools", accent: "#0F766E", background: "#F0FDFA",
      rationale: "Freelancers repeatedly buy invoice and tax trackers." }) as any;
    const sb = await executeTool(ctx(taskId), tools, "submit_draft", { draft_id: b.draft_id, justification: "Apply the chosen brand to the store." }) as any;
    expect(sb.status).toBe("queued_for_execution");
    const p = await executeTool(ctx(taskId), tools, "build_digital_product", spreadsheetProduct) as any;
    expect(p.file.bytes).toBeGreaterThan(1000);
    const assets = (await db.query(`SELECT role FROM store_assets WHERE product_id = $1 ORDER BY role`, [p.product_id])).rows.map((r) => r.role);
    expect(assets).toEqual(["cover", "deliverable", "preview"]);
    const sp = await executeTool(ctx(taskId), tools, "submit_draft", { draft_id: p.draft_id, justification: "Product is complete and useful." }) as any;
    expect(sp).toMatchObject({ status: "queued_for_execution", action: "store.publish_owned" });

    // Run both queued executions. Agent is not live => simulated, no Shopify calls.
    for (let i = 0; i < 2; i++) {
      const t = await claimNext(db, "w");
      expect(t!.type).toBe("execute_action");
      const r = await runTask({ db, llm: {} as any, workerId: "w" }, t!) as any;
      expect(r.sandbox).toBe(true);
    }
    const brand = (await db.query(`SELECT value FROM kv_store WHERE key = 'store_brand'`)).rows[0].value;
    expect(brand).toMatchObject({ name: "Ledgerly", sandbox: true });
    expect((await db.query(`SELECT status FROM store_products WHERE id = $1`, [p.product_id])).rows[0].status).toBe("built");
  });

  it("replays sandbox work for real once the agent goes live, once", async () => {
    expect(await promoteSandboxDrafts(db)).toBe(0); // still sandbox
    await db.query(`UPDATE agents SET live_mode = TRUE WHERE id = 'digital_store'`);
    try {
      expect(await promoteSandboxDrafts(db)).toBe(2);
      expect(await promoteSandboxDrafts(db)).toBe(0);
      const q = (await db.query(`SELECT priority, payload FROM tasks WHERE created_by = 'store_sync' AND status = 'queued' ORDER BY priority`)).rows;
      expect(q.map((t) => t.priority)).toEqual([2, 3]);
      expect(q.every((t) => t.payload.action === "store.publish_owned")).toBe(true);
      await db.query(`UPDATE tasks SET status = 'cancelled' WHERE created_by = 'store_sync'`);
    } finally { await db.query(`UPDATE agents SET live_mode = FALSE WHERE id = 'digital_store'`); }
  });

  it("caps new products per day", async () => {
    await executeTool(ctx(taskId), tools, "build_digital_product", { ...spreadsheetProduct, title: "Second Tracker" });
    await executeTool(ctx(taskId), tools, "build_digital_product", { ...spreadsheetProduct, title: "Third Tracker" });
    await expect(executeTool(ctx(taskId), tools, "build_digital_product", { ...spreadsheetProduct, title: "Fourth Tracker" })).rejects.toMatchObject({ code: "daily_product_limit" });
  });

  it("rejects prices outside $3-$99 and other agents cannot use store tools", async () => {
    await expect(executeTool(ctx(taskId), tools, "build_digital_product", { ...spreadsheetProduct, listing: { ...spreadsheetProduct.listing, price_usd: 500 } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(executeTool({ db, agentId: "web_agency", taskId }, AGENT_BY_ID.web_agency.tools, "build_digital_product", spreadsheetProduct)).rejects.toMatchObject({ code: "tool_not_allowed" });
  });
});

describe("order sync -> ledger and delivery", () => {
  let productId: string;
  beforeAll(async () => {
    productId = (await db.query(`SELECT id FROM store_products ORDER BY created_at LIMIT 1`)).rows[0].id;
    await db.query(`UPDATE store_products SET shopify_product_id = 'gid://shopify/Product/1', status = 'published' WHERE id = $1`, [productId]);
  });
  const order = (o: any = {}) => ({
    id: "gid://shopify/Order/100", name: "#1001", test: false, createdAt: "2026-11-13T10:00:00Z", updatedAt: "2026-11-13T10:00:00Z",
    displayFinancialStatus: "PAID", cancelledAt: null, subtotalPriceSet: { shopMoney: { amount: "9.00" } }, refunds: [],
    transactions: [{ id: "gid://shopify/OrderTransaction/5", kind: "SALE", status: "SUCCESS", createdAt: "2026-11-13T10:00:00Z", fees: [{ amount: { amount: "0.56" } }] }],
    lineItems: { nodes: [{ id: "li1", quantity: 1, product: { id: "gid://shopify/Product/1" }, discountedTotalSet: { shopMoney: { amount: "9.00" } } }] },
    fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/7", status: "OPEN" }] }, ...o,
  });
  const ledger = async () => (await db.query(`SELECT entry_type, amount_cents, verified, sandbox FROM ledger_entries WHERE source IN ('shopify','sandbox') AND entry_type IN ('revenue','refund','processing_fee') AND agent_id = 'digital_store' ORDER BY entry_type`)).rows;

  it("records verified revenue and fees once, even when re-synced", async () => {
    await applyOrder(db, order());
    await applyOrder(db, order());
    expect(await ledger()).toEqual([
      { entry_type: "processing_fee", amount_cents: -56, verified: true, sandbox: false },
      { entry_type: "revenue", amount_cents: 900, verified: true, sandbox: false },
    ]);
  });

  it("delivers by fulfilling with a secret link, once", async () => {
    const s = fakeShopify({ id: "gid://shopify/Shop/1", name: "Ledgerly", myshopifyDomain: APEX }, {
      "orders(": () => ({ orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [order()] } }),
      fulfillmentCreate: () => ({ fulfillmentCreate: { fulfillment: { id: "f1" }, userErrors: [] } }),
    });
    const r = await syncStore(db, new ShopifyClient(db, s.f));
    expect(r).toMatchObject({ orders: 1, delivered: 1 });
    const m = s.mutations().find((c) => c.query.includes("fulfillmentCreate"))!;
    expect(m.variables.fulfillment.trackingInfo.url).toMatch(/^https:\/\/universe\.example\/d\/[A-Za-z0-9_-]{20,}$/);
    expect(m.variables.fulfillment.notifyCustomer).toBe(true);
    const again = await syncStore(db, new ShopifyClient(db, s.f));
    expect(again.delivered).toBe(0);
    expect((await db.query(`SELECT units_sold, revenue_cents FROM store_products WHERE id = $1`, [productId])).rows[0]).toEqual({ units_sold: 1, revenue_cents: 900 });
  });

  it("refunds are recorded and revoke the download link", async () => {
    await applyOrder(db, order({ displayFinancialStatus: "REFUNDED", refunds: [{ id: "gid://shopify/Refund/3", createdAt: "2026-11-14T10:00:00Z", totalRefundedSet: { shopMoney: { amount: "9.00" } } }] }));
    expect((await ledger()).find((e) => e.entry_type === "refund")).toMatchObject({ amount_cents: -900, verified: true });
    expect((await db.query(`SELECT revoked FROM store_deliveries`)).rows.every((r) => r.revoked)).toBe(true);
  });

  it("test orders never count as real revenue", async () => {
    await applyOrder(db, order({ id: "gid://shopify/Order/200", name: "#T1", test: true, transactions: [] }));
    const t = (await db.query(`SELECT verified, sandbox FROM ledger_entries WHERE external_ref = 'gid://shopify/Order/200'`)).rows[0];
    expect(t).toEqual({ verified: false, sandbox: true });
  });
});
