-- Agent 01: Digital Product Store on the owner's Shopify store (Apex only).

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_draft_type_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_draft_type_check CHECK (draft_type IN
  ('product_listing','proposal','outreach','short_form_script','landing_page','seo_article','ad_copy','support_reply','report','other',
   'store_product','store_branding'));

-- Products the agent designed. Files live in store_assets.
CREATE TABLE store_products (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  kind               TEXT NOT NULL CHECK (kind IN ('spreadsheet','planner')),
  niche              TEXT NOT NULL,
  title              TEXT NOT NULL,
  spec               JSONB NOT NULL,
  listing            JSONB NOT NULL,      -- {title, description_html, price_cents, compare_at_cents, tags}
  status             TEXT NOT NULL DEFAULT 'built' CHECK (status IN ('built','published','archived')),
  shopify_product_id TEXT UNIQUE,
  shopify_handle     TEXT,
  experiment_id      UUID REFERENCES experiments(id),
  experiment_variant TEXT,
  units_sold         INT NOT NULL DEFAULT 0,
  revenue_cents      BIGINT NOT NULL DEFAULT 0,
  refunds            INT NOT NULL DEFAULT 0,
  draft_id           UUID REFERENCES drafts(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('deliverable','cover','preview')),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  size_bytes  INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX store_assets_product ON store_assets(product_id, role);

-- Orders pulled from Shopify (no customer personal data is stored).
CREATE TABLE store_orders (
  shopify_order_id  TEXT PRIMARY KEY,
  name              TEXT,
  test              BOOLEAN NOT NULL DEFAULT FALSE,
  financial_status  TEXT,
  subtotal_cents    BIGINT NOT NULL DEFAULT 0,
  refunded_cents    BIGINT NOT NULL DEFAULT 0,
  fees_cents        BIGINT NOT NULL DEFAULT 0,
  line_items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ordered_at        TIMESTAMPTZ NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One secret download link per (order, product). Revoked on refund.
CREATE TABLE store_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id  TEXT NOT NULL REFERENCES store_orders(shopify_order_id),
  product_id        UUID NOT NULL REFERENCES store_products(id),
  token             TEXT NOT NULL UNIQUE,
  revoked           BOOLEAN NOT NULL DEFAULT FALSE,
  downloads         INT NOT NULL DEFAULT 0,
  fulfilled_at      TIMESTAMPTZ,
  fulfill_error     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shopify_order_id, product_id)
);
