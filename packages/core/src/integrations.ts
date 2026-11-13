/**
 * External integrations. Each adapter has a sandbox implementation (always
 * available, no side effects) and optionally a live one that is used only when
 * the agent is in live mode AND credentials are configured on the server.
 */
export interface ExecutionResult { ref: string; sandbox: boolean; detail: string }

export interface DraftForExecution { id: string; agent_id: string; draft_type: string; title: string; body: string; metadata: any }

type Adapter = {
  isConfigured: () => boolean;
  live: (d: DraftForExecution) => Promise<ExecutionResult>;
};

const shopify: Adapter = {
  isConfigured: () => !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN),
  // Creates the product via the official Admin GraphQL API. Status defaults to
  // DRAFT so it appears in Shopify admin for a final look before going on sale.
  live: async (d) => {
    await assertShopifyStoreAllowed();
    const status = process.env.SHOPIFY_PRODUCT_STATUS === "ACTIVE" ? "ACTIVE" : "DRAFT";
    const res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN! },
      body: JSON.stringify({
        query: `mutation($product: ProductCreateInput!) { productCreate(product: $product) { product { id } userErrors { field message } } }`,
        variables: { product: { title: d.title, descriptionHtml: d.body, status, productType: "Digital product", tags: ["ai-universe"] } },
      }),
    });
    const json: any = await res.json();
    const errs = json?.data?.productCreate?.userErrors ?? json?.errors;
    if (!res.ok || (errs && errs.length)) throw new Error(`Shopify productCreate failed: ${JSON.stringify(errs ?? res.status)}`);
    return { ref: json.data.productCreate.product.id, sandbox: false, detail: `Created Shopify product (${status})` };
  },
};

/**
 * Hard guard: the owner's existing store must never be modified. We ask
 * Shopify which shop the token belongs to and refuse if it matches the
 * blocklist (SHOPIFY_BLOCKED_STORES, default covers TXC Designs).
 */
export const DEFAULT_BLOCKED_STORES = ["txc designs", "txcdesigns", "txcdesigns.com", "txc-designs"];

export function isBlockedStore(info: { name?: string; myshopifyDomain?: string; primaryHost?: string }, extra = process.env.SHOPIFY_BLOCKED_STORES): boolean {
  const blocked = [...DEFAULT_BLOCKED_STORES, ...(extra ? extra.split(",") : [])].map((s) => s.trim().toLowerCase()).filter(Boolean);
  const norm = (v?: string) => (v ?? "").toLowerCase();
  const fields = [norm(info.name), norm(info.myshopifyDomain), norm(info.primaryHost), norm(info.name).replace(/\s+/g, "")];
  return fields.some((f) => f && blocked.some((b) => f === b || f.includes(b.replace(/\s+/g, ""))));
}

async function assertShopifyStoreAllowed() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN!;
  if (isBlockedStore({ myshopifyDomain: domain })) throw new Error(`Refusing to write to blocked Shopify store ${domain}`);
  const res = await fetch(`https://${domain}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN! },
    body: JSON.stringify({ query: `{ shop { name myshopifyDomain primaryDomain { host } } }` }),
  });
  const shop = (await res.json() as any)?.data?.shop;
  if (!shop) throw new Error("Could not verify Shopify store identity; refusing to write");
  if (isBlockedStore({ name: shop.name, myshopifyDomain: shop.myshopifyDomain, primaryHost: shop.primaryDomain?.host }))
    throw new Error(`Refusing to write to blocked Shopify store "${shop.name}"`);
}

const ADAPTERS: Record<string, Adapter | undefined> = {
  "listing.publish": shopify,
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

export async function executeExternal(action: string, draft: DraftForExecution, live: boolean): Promise<ExecutionResult> {
  const adapter = ADAPTERS[action];
  if (live && adapter?.isConfigured()) return adapter.live(draft);
  return { ref: `sandbox:${action}:${draft.id}`, sandbox: true,
    detail: adapter ? "Simulated (agent in sandbox mode or credentials missing)" : "No live integration yet: approved and ready for manual sending/publishing" };
}
