import type { Queryable } from "../db.js";
import { notify } from "../notify.js";
import { ShopifyClient } from "./shopify.js";

/**
 * Deterministic store operations. They run only from the execution queue
 * (never directly from the model), after the policy gate, and every write
 * goes through ShopifyClient.mutate(), which re-verifies the store first.
 */

export function publicBaseUrl(): string {
  const u = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (!u) throw new Error("PUBLIC_BASE_URL is not set (the dashboard's public https address, used for images and download links)");
  return u.replace(/\/$/, "");
}

export const MIN_PRICE_CENTS = 300;
export const MAX_PRICE_CENTS = 9900;
const money = (c: number) => (c / 100).toFixed(2);

export async function getBrand(q: Queryable): Promise<{ name: string; tagline?: string; niche?: string; accent?: string; background?: string } | null> {
  return (await q.query(`SELECT value FROM kv_store WHERE key = 'store_brand'`)).rows[0]?.value ?? null;
}

async function onlineStorePublicationId(c: ShopifyClient): Promise<string | null> {
  const d = await c.query(`{ publications(first: 20) { nodes { id name } } }`);
  return d.publications.nodes.find((p: any) => /online store/i.test(p.name))?.id ?? null;
}

export async function publishStoreProduct(db: Queryable, c: ShopifyClient, productId: string) {
  const p = (await db.query(`SELECT * FROM store_products WHERE id = $1`, [productId])).rows[0];
  if (!p) throw new Error(`store product ${productId} not found`);
  if (p.shopify_product_id) return { ref: p.shopify_product_id, detail: "Already on Shopify" };
  const brand = await getBrand(db);
  const L = p.listing;
  const base = publicBaseUrl();
  const imgs = (await db.query(`SELECT id, role FROM store_assets WHERE product_id = $1 AND role IN ('cover','preview') ORDER BY role`, [productId])).rows;

  const created = await c.mutate(
    `mutation($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) { product { id handle variants(first: 1) { nodes { id } } } userErrors { field message } } }`,
    {
      product: { title: L.title, descriptionHtml: L.description_html, status: "ACTIVE", productType: "Digital download",
        vendor: brand?.name ?? "Digital Store", tags: [...new Set([...(L.tags ?? []), "ai-universe", "digital-download", p.kind])] },
      media: imgs.map((i: any) => ({ originalSource: `${base}/api/store/assets/${i.id}.png`, mediaContentType: "IMAGE", alt: `${L.title} (${i.role})` })),
    }, "productCreate");
  const prod = created.product;
  await db.query(`UPDATE store_products SET shopify_product_id = $2, shopify_handle = $3, updated_at = now() WHERE id = $1`, [productId, prod.id, prod.handle]);

  await c.mutate(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }`,
    { productId: prod.id, variants: [{ id: prod.variants.nodes[0].id, price: money(L.price_cents),
      compareAtPrice: L.compare_at_cents ? money(L.compare_at_cents) : null,
      inventoryPolicy: "CONTINUE", inventoryItem: { requiresShipping: false, tracked: false } }] },
    "productVariantsBulkUpdate");

  const pub = await onlineStorePublicationId(c);
  if (pub) {
    await c.mutate(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
      { id: prod.id, input: [{ publicationId: pub }] }, "publishablePublish");
  }
  await db.query(`UPDATE store_products SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1`, [productId]);
  return { ref: prod.id, detail: `Live on the store as /products/${prod.handle}${pub ? "" : " (Online Store channel not found: not visible yet)"}` };
}

export async function updateStoreProduct(db: Queryable, c: ShopifyClient, productId: string, change: { price_cents?: number; title?: string; description_html?: string; archive?: boolean }) {
  const p = (await db.query(`SELECT * FROM store_products WHERE id = $1`, [productId])).rows[0];
  if (!p?.shopify_product_id) throw new Error("Product is not on Shopify yet");
  if (change.archive) {
    await c.mutate(`mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`,
      { product: { id: p.shopify_product_id, status: "ARCHIVED" } }, "productUpdate");
    await db.query(`UPDATE store_products SET status = 'archived', updated_at = now() WHERE id = $1`, [productId]);
    return { ref: p.shopify_product_id, detail: "Archived" };
  }
  if (change.title || change.description_html) {
    await c.mutate(`mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`,
      { product: { id: p.shopify_product_id, ...(change.title ? { title: change.title } : {}), ...(change.description_html ? { descriptionHtml: change.description_html } : {}) } }, "productUpdate");
  }
  if (change.price_cents) {
    const d = await c.query(`query($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }`, { id: p.shopify_product_id });
    await c.mutate(`mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }`,
      { productId: p.shopify_product_id, variants: [{ id: d.product.variants.nodes[0].id, price: money(change.price_cents) }] }, "productVariantsBulkUpdate");
  }
  const listing = { ...p.listing, ...(change.title ? { title: change.title } : {}), ...(change.description_html ? { description_html: change.description_html } : {}),
    ...(change.price_cents ? { price_cents: change.price_cents } : {}) };
  await db.query(`UPDATE store_products SET listing = $2, updated_at = now() WHERE id = $1`, [productId, JSON.stringify(listing)]);
  return { ref: p.shopify_product_id, detail: `Updated ${Object.keys(change).join(", ")}` };
}

/**
 * Rebrand: About page, an automatic collection of the agent's products,
 * archive leftover products from the store's old life (reversible: archive,
 * never delete), and remember the brand. The store's display name itself is
 * changed by the owner in Settings (Shopify has no API for it); a
 * notification tells them exactly what to type.
 */
export async function applyBranding(db: Queryable, c: ShopifyClient, b: {
  name: string; tagline: string; niche: string; about_html: string; collection_title: string; accent: string; background: string;
}) {
  const done: string[] = [];
  const shop = await c.assertWritable();

  const existing = await c.query(`{ pages(first: 1, query: "handle:about") { nodes { id } } }`);
  const page = existing.pages.nodes[0];
  if (page) {
    await c.mutate(`mutation($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`,
      { id: page.id, page: { title: `About ${b.name}`, body: b.about_html, isPublished: true } }, "pageUpdate");
  } else {
    await c.mutate(`mutation($page: PageCreateInput!) { pageCreate(page: $page) { page { id } userErrors { field message } } }`,
      { page: { title: `About ${b.name}`, handle: "about", body: b.about_html, isPublished: true } }, "pageCreate");
  }
  done.push("About page");

  const prevBrand = await getBrand(db);
  const col = await c.query(`{ collections(first: 1, query: "title:'Shop all digital'") { nodes { id } } }`).catch(() => null);
  const colId = (prevBrand as any)?.collection_id ?? col?.collections?.nodes?.[0]?.id;
  if (colId) {
    await c.mutate(`mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: { id: colId, title: b.collection_title, descriptionHtml: `<p>${b.tagline}</p>` } }, "collectionUpdate");
  }
  const collectionId = colId ?? (await c.mutate(`mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
    { input: { title: b.collection_title, descriptionHtml: `<p>${b.tagline}</p>`,
      ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "ai-universe" }] } } }, "collectionCreate")).collection.id;
  done.push("collection");

  // Retire products from the store's previous life (up to 50 per run).
  const old = await c.query(`{ products(first: 50, query: "status:active AND tag_not:ai-universe") { nodes { id title } } }`);
  for (const p of old.products.nodes) {
    await c.mutate(`mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`,
      { product: { id: p.id, status: "ARCHIVED" } }, "productUpdate");
  }
  if (old.products.nodes.length) done.push(`archived ${old.products.nodes.length} old product(s)`);

  const brand = { ...b, collection_id: collectionId, applied_at: new Date().toISOString(), previous: prevBrand?.name ?? null };
  await db.query(`INSERT INTO kv_store (key, value) VALUES ('store_brand', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(brand)]);
  if (shop.name !== b.name) {
    await notify(db, { severity: "info", agentId: "digital_store", title: `Rename the store to "${b.name}" (30 seconds)`,
      body: `In Shopify admin for ${shop.myshopifyDomain}: Settings > General > Store name, type "${b.name}", Save. Shopify does not let apps change the name.`,
      dedupeKey: `rename:${b.name}` });
  }
  return { ref: collectionId, detail: `Rebranded to ${b.name}: ${done.join(", ")}` };
}
