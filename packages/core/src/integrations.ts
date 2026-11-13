/**
 * External integrations. Each adapter has a sandbox implementation (always
 * available, no side effects) and optionally a live one that is used only when
 * the agent is in live mode AND credentials are configured on the server.
 */
import type { Queryable } from "./db.js";
import { ShopifyClient, shopifyConfigured } from "./store/shopify.js";
import { executeStoreDraft } from "./store/tools.js";
export { isBlockedStore, DEFAULT_BLOCKED_STORES } from "./store/guard.js";

export interface ExecutionResult { ref: string; sandbox: boolean; detail: string }

export interface DraftForExecution { id: string; agent_id: string; draft_type: string; title: string; body: string; metadata: any }

type Adapter = {
  isConfigured: () => boolean;
  live: (d: DraftForExecution, db: Queryable) => Promise<ExecutionResult>;
  sandbox?: (d: DraftForExecution, db: Queryable) => Promise<void>;
};

/**
 * Generic product listing (Level 3, individual approval): creates a DRAFT
 * product on the allowed store only. The Digital Product Store's own flow uses
 * store.publish_owned below.
 */
const shopifyListing: Adapter = {
  isConfigured: shopifyConfigured,
  live: async (d, db) => {
    const c = new ShopifyClient(db);
    const out = await c.mutate(
      `mutation($product: ProductCreateInput!) { productCreate(product: $product) { product { id } userErrors { field message } } }`,
      { product: { title: d.title, descriptionHtml: d.body, status: "DRAFT", productType: "Digital product", tags: ["ai-universe"] } }, "productCreate");
    return { ref: out.product.id, sandbox: false, detail: "Created Shopify product (DRAFT)" };
  },
};

/** Digital Product Store: brand + products on the owner's allowed store (Apex). */
const storeOwned: Adapter = {
  isConfigured: shopifyConfigured,
  live: (d, db) => executeStoreDraft(db, d),
  // In sandbox the brand is still remembered locally so products are designed under it.
  sandbox: async (d, db) => {
    if (d.draft_type === "store_branding" && d.metadata?.brand) {
      await db.query(`INSERT INTO kv_store (key, value) VALUES ('store_brand', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify({ ...d.metadata.brand, sandbox: true, applied_at: new Date().toISOString() })]);
    }
  },
};

const ADAPTERS: Record<string, Adapter | undefined> = {
  "listing.publish": shopifyListing,
  "store.publish_owned": storeOwned,
  // No email / social / CMS adapters are wired yet. These actions run in
  // sandbox only, which marks the draft "approved, ready to send manually".
  "outreach.send": undefined,
  "content.publish_approved": undefined,
  "website.update_owned": undefined,
  "customer.routine_request": undefined,
  "ads.launch": undefined,
};

export function integrationStatus() {
  return Object.entries(ADAPTERS).map(([action, a]) => ({ action, liveAvailable: !!a?.isConfigured() }));
}

export function canRunLive(action: string): boolean {
  return !!ADAPTERS[action]?.isConfigured();
}

export async function executeExternal(action: string, draft: DraftForExecution, live: boolean, db: Queryable): Promise<ExecutionResult> {
  const adapter = ADAPTERS[action];
  if (live && adapter?.isConfigured()) return adapter.live(draft, db);
  await adapter?.sandbox?.(draft, db);
  return { ref: `sandbox:${action}:${draft.id}`, sandbox: true,
    detail: adapter ? "Simulated (agent in sandbox mode or credentials missing)" : "No live integration yet: approved and ready for manual sending/publishing" };
}
