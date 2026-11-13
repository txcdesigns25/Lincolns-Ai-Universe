/**
 * Store guard: the Digital Product Store may write to exactly ONE Shopify
 * store, the owner's (formerly unused) "Apex Motorsports" store. Every other
 * store on the owner's account is refused, above all TXC Designs (a live
 * business). This file is pure logic so it can be unit-tested exhaustively.
 *
 * Rules, all of which must pass before any write:
 *  1. SHOPIFY_ALLOWED_STORE is set (the allowed store's permanent
 *     xxxx.myshopify.com domain). No allowlist => no writes at all.
 *  2. The configured SHOPIFY_STORE_DOMAIN equals the allowlisted domain.
 *  3. The shop Shopify reports for the token (asked live, before each write)
 *     has that same myshopify domain. The display name is NOT trusted for
 *     allowing, because the rebrand changes it.
 *  4. Nothing about the shop (name, domains) matches the blocklist.
 *  5. Once a store passes, its shop id is pinned; a different shop id is
 *     refused even if the env vars are later changed to point at it.
 */

export const DEFAULT_BLOCKED_STORES = [
  "txc designs", "txcdesigns", "txcdesigns.com", "txc-designs", "cmr0ny-mc.myshopify.com",
  "txc powersports", "txcpowersports", "burning-albatross",
];

export interface ShopIdentity { id?: string; name?: string; myshopifyDomain?: string; primaryHost?: string }

const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();
const squash = (v: string) => v.replace(/[\s_-]+/g, "");

export function blockedList(extra = process.env.SHOPIFY_BLOCKED_STORES): string[] {
  return [...DEFAULT_BLOCKED_STORES, ...(extra ? extra.split(",") : [])].map(norm).filter(Boolean);
}

export function isBlockedStore(info: ShopIdentity, extra = process.env.SHOPIFY_BLOCKED_STORES): boolean {
  const blocked = blockedList(extra).map(squash);
  const fields = [info.name, info.myshopifyDomain, info.primaryHost].map(norm).filter(Boolean).map(squash);
  return fields.some((f) => blocked.some((b) => f === b || f.includes(b)));
}

export function normalizeShopDomain(d?: string | null): string {
  return norm(d).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/** Static checks that need no network: run before even asking Shopify. */
export function checkConfig(env: { storeDomain?: string; allowedStore?: string }): GuardResult {
  const allowed = normalizeShopDomain(env.allowedStore);
  const domain = normalizeShopDomain(env.storeDomain);
  if (!allowed) return { ok: false, reason: "SHOPIFY_ALLOWED_STORE is not set, so no store may be written to" };
  if (!allowed.endsWith(".myshopify.com")) return { ok: false, reason: "SHOPIFY_ALLOWED_STORE must be the store's xxxx.myshopify.com domain" };
  if (!domain) return { ok: false, reason: "SHOPIFY_STORE_DOMAIN is not set" };
  if (domain !== allowed) return { ok: false, reason: `SHOPIFY_STORE_DOMAIN (${domain}) is not the allowed store (${allowed})` };
  if (isBlockedStore({ myshopifyDomain: domain })) return { ok: false, reason: `${domain} is on the blocklist` };
  return { ok: true };
}

/** Live check against what Shopify says the token's shop is. */
export function checkIdentity(shop: ShopIdentity | null | undefined, env: { allowedStore?: string; pinnedShopId?: string | null }): GuardResult {
  if (!shop || !shop.myshopifyDomain) return { ok: false, reason: "Could not verify which store the token belongs to" };
  const allowed = normalizeShopDomain(env.allowedStore);
  if (normalizeShopDomain(shop.myshopifyDomain) !== allowed)
    return { ok: false, reason: `Token belongs to ${shop.myshopifyDomain} ("${shop.name}"), not the allowed store ${allowed}` };
  if (isBlockedStore(shop)) return { ok: false, reason: `Store "${shop.name}" (${shop.myshopifyDomain}) is on the blocklist` };
  if (env.pinnedShopId && shop.id && env.pinnedShopId !== shop.id)
    return { ok: false, reason: `Shop id ${shop.id} differs from the pinned store ${env.pinnedShopId}` };
  return { ok: true };
}
