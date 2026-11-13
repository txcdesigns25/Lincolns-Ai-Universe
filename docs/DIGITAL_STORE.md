# Agent 01: Digital Product Store

The agent runs one Shopify store end to end: it picks the niche and brand, designs original spreadsheets and printable planners, lists them, delivers them to buyers, and learns from verified sales. The owner's unused **Apex Motorsports** store is the only store it may touch.

## How it works

| Step | Who | What happens |
|---|---|---|
| Choose niche + brand | Agent (`set_store_brand`) | Name, tagline, About page, colors, with its reasoning saved to memory. |
| Build product | Agent (`build_digital_product`) | Agent writes a structured spec; the platform renders a real `.xlsx` (exceljs) or `.pdf` (pdfkit) and two 1600×1600 listing images (resvg). Max 3 new products/day, price $3–$99. |
| Go live | Queue (`store.publish_owned`, Level 2) | Owner granted this once (2026-11-13), so no per-item approval. Runs only when the agent is in **live mode**; in sandbox it is simulated. |
| Rebrand store | Executor | About page, an automatic "all products" collection, archives (never deletes) old Apex products. Store *name* must be changed by the owner in Settings (no API); a notification says what to type. |
| Sell + deliver | Worker sync, every 15 min, no AI cost | Pulls orders; on payment creates a secret download link and fulfills the order with it, so Shopify emails the buyer. Download page: `/d/<token>` (25 downloads max, revoked on full refund). |
| Money | Worker sync | Revenue (order subtotal), refunds, and Shopify Payments fees go into the agent ledger as verified entries; test orders are sandbox and never count. |
| Learn | Agent | Per-product units/revenue/refunds feed `get_store_status`; experiments linked to product variants get conversions and revenue per variant. |

Still needs the owner: spending money (ads, apps, Shopify plan), legal pages (refund policy, terms), anything on another store.

## Store guard

Every write goes through `ShopifyClient.mutate()`, which first asks Shopify which shop the credentials belong to. It refuses unless the shop's permanent `xxxx.myshopify.com` domain equals `SHOPIFY_ALLOWED_STORE`, nothing matches the blocklist, and the shop id matches the one pinned on first successful write. The display name is never trusted for allowing, because the rebrand changes it.

## Known limits

- Experiments record conversions and revenue per variant; storefront views ("trials") are not wired yet, so the significance test cannot declare a winner. Compare revenue per variant over equal time windows instead.
- The agent has no live web search yet; it picks niches from its own knowledge and learns from sales.
- The delivery email is Shopify's "shipping confirmation" with the link as the tracking URL. Optional: edit its wording in Shopify admin > Settings > Notifications > Shipping confirmation.

## Setup (owner)

Worker service variables on Railway:

```
SHOPIFY_STORE_DOMAIN=<apex>.myshopify.com
SHOPIFY_ALLOWED_STORE=<apex>.myshopify.com
SHOPIFY_CLIENT_ID=...        # or SHOPIFY_ADMIN_TOKEN=shpat_...
SHOPIFY_CLIENT_SECRET=...
PUBLIC_BASE_URL=https://lincolns-ai-universe-production.up.railway.app
```

App scopes: `read_products, write_products, read_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_online_store_pages, write_online_store_pages, read_publications, write_publications`.

Then in the dashboard: Agents > Digital Product Store > set Active and turn on Live mode.
