import type { Queryable } from "../db.js";
import { audit } from "../audit.js";
import { PolicyDenied, RetryableError } from "../errors.js";
import { checkConfig, checkIdentity, normalizeShopDomain, type ShopIdentity } from "./guard.js";

/**
 * Minimal Shopify Admin GraphQL client for the allowed store.
 *
 * Auth, either:
 *  - SHOPIFY_ADMIN_TOKEN (a store's Admin API access token, "shpat_..."), or
 *  - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for an app from the Shopify
 *    Dev Dashboard installed on the store (client-credentials grant; the
 *    token is fetched and refreshed automatically).
 *
 * Reads go straight through. Every write (`mutate`) first re-verifies the
 * shop identity with the guard and refuses on any mismatch.
 */
export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2025-10";

export function shopifyConfigured(): boolean {
  return !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ALLOWED_STORE &&
    (process.env.SHOPIFY_ADMIN_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)));
}

type Fetch = typeof fetch;
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(f: Fetch): Promise<string> {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const domain = normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN);
  const res = await f(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.SHOPIFY_CLIENT_ID!, client_secret: process.env.SHOPIFY_CLIENT_SECRET! }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Shopify token request failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  cachedToken = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

export class ShopifyClient {
  constructor(private db: Queryable, private f: Fetch = fetch) {}

  private get domain() { return normalizeShopDomain(process.env.SHOPIFY_STORE_DOMAIN); }

  private async raw<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const cfg = checkConfig({ storeDomain: process.env.SHOPIFY_STORE_DOMAIN, allowedStore: process.env.SHOPIFY_ALLOWED_STORE });
    if (!cfg.ok) throw new PolicyDenied("store_guard", cfg.reason);
    const res = await this.f(`https://${this.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken(this.f) },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Shopify ${res.status}`);
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
    if (json.errors?.length) {
      if (json.errors.some((e: any) => e?.extensions?.code === "THROTTLED")) throw new RetryableError("Shopify throttled");
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors).slice(0, 800)}`);
    }
    return json.data as T;
  }

  async shop(): Promise<ShopIdentity & { currencyCode?: string; email?: string }> {
    const d = await this.raw(`{ shop { id name myshopifyDomain currencyCode primaryDomain { host } } }`);
    const s = d?.shop;
    return s ? { id: s.id, name: s.name, myshopifyDomain: s.myshopifyDomain, primaryHost: s.primaryDomain?.host, currencyCode: s.currencyCode } : {} as any;
  }

  /** Read-only query. */
  async query<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (/^\s*mutation\b/i.test(query)) throw new PolicyDenied("store_guard", "Use mutate() for writes");
    return this.raw<T>(query, variables);
  }

  /** Verify the store is the allowed one, then pin its id. Throws PolicyDenied otherwise. */
  async assertWritable(): Promise<ShopIdentity> {
    const shop = await this.shop();
    const pinned = (await this.db.query(`SELECT value FROM kv_store WHERE key = 'shopify_pinned_shop'`)).rows[0]?.value;
    const r = checkIdentity(shop, { allowedStore: process.env.SHOPIFY_ALLOWED_STORE, pinnedShopId: pinned?.id ?? null });
    if (!r.ok) {
      await audit(this.db, { actor: "store_guard", agentId: "digital_store", action: "shopify.write", outcome: "denied", details: { reason: r.reason, shop } });
      throw new PolicyDenied("store_guard", r.reason);
    }
    if (!pinned && shop.id) {
      await this.db.query(`INSERT INTO kv_store (key, value) VALUES ('shopify_pinned_shop', $1) ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify({ id: shop.id, myshopifyDomain: shop.myshopifyDomain, pinnedAt: new Date().toISOString() })]);
    }
    return shop;
  }

  /** Guarded write: re-checks the store identity before every mutation. Returns data; throws on userErrors. */
  async mutate<T = any>(mutation: string, variables: Record<string, unknown>, resultKey: string): Promise<T> {
    if (!/^\s*mutation\b/i.test(mutation)) throw new PolicyDenied("store_guard", "mutate() only accepts mutations");
    await this.assertWritable();
    const d: any = await this.raw(mutation, variables);
    const out = d?.[resultKey];
    const errs = out?.userErrors;
    if (errs?.length) throw new Error(`Shopify ${resultKey} failed: ${JSON.stringify(errs).slice(0, 800)}`);
    return out as T;
  }
}
