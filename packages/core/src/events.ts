import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { enqueue } from "./queue.js";
import { recordProviderEntry } from "./ledger.js";
import { AGENT_BY_ID } from "./agents.js";

/** Event-driven entry point: store raw inbound events idempotently. */
export async function storeInboundEvent(db: Db, e: { source: string; externalId?: string; agentId?: string; payload: unknown }) {
  const r = await db.query(
    `INSERT INTO inbound_events (source, external_id, agent_id, payload) VALUES ($1,$2,$3,$4)
     ON CONFLICT (source, external_id) DO NOTHING RETURNING id`,
    [e.source, e.externalId ?? null, e.agentId ?? null, JSON.stringify(e.payload)]);
  return { id: r.rows[0]?.id as string | undefined, duplicate: !r.rowCount };
}

/** Worker step: process unprocessed events into customers, ledger rows, and tasks. */
export async function processInboundEvents(db: Db, limit = 20): Promise<number> {
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const done = await withTx(db, async (tx) => {
      const ev = (await tx.query(`SELECT * FROM inbound_events WHERE NOT processed ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!ev) return false;
      if (ev.source === "landing_form" && ev.agent_id && AGENT_BY_ID[ev.agent_id]) {
        const p = ev.payload;
        const c = await tx.query(
          `INSERT INTO customers (owner_agent_id, name, email, company, status, source, notes, sandbox)
           VALUES ($1,$2,$3,$4,'lead','landing_form',$5,$6) RETURNING id`,
          [ev.agent_id, String(p.name ?? "Unknown").slice(0, 200), p.email ?? null, p.company ?? null, String(p.message ?? "").slice(0, 4000), !!p.sandbox]);
        await enqueue(tx, { agentId: ev.agent_id, type: "inbound_lead", title: `New inbound lead: ${p.name ?? "unknown"}`,
          payload: { customer_id: c.rows[0].id, message: p.message ?? "", company: p.company ?? null }, priority: 2,
          idempotencyKey: `lead:${ev.id}`, createdBy: "event" });
      }
      if (ev.source === "stripe") await applyStripeEvent(tx, ev.payload);
      await tx.query(`UPDATE inbound_events SET processed = TRUE WHERE id = $1`, [ev.id]);
      return true;
    });
    if (!done) break;
    n++;
  }
  return n;
}

/**
 * Stripe: charge.succeeded => revenue (+ fee if balance data present),
 * charge.refunded => refund. The owning agent comes from metadata.agent_id.
 * Idempotent through the ledger's (source, external_ref, type) uniqueness.
 */
async function applyStripeEvent(q: any, evt: any) {
  const obj = evt?.data?.object;
  const agentId = obj?.metadata?.agent_id;
  if (!obj || !agentId || !AGENT_BY_ID[agentId]) return;
  if (evt.type === "charge.succeeded") {
    await recordProviderEntry(q, { agentId, type: "revenue", amountCents: obj.amount, source: evt.livemode ? "stripe" : "sandbox",
      externalRef: obj.id, description: obj.description ?? "Stripe charge" });
  }
  if (evt.type === "charge.refunded") {
    await recordProviderEntry(q, { agentId, type: "refund", amountCents: obj.amount_refunded, source: evt.livemode ? "stripe" : "sandbox",
      externalRef: obj.id, description: "Stripe refund" });
  }
}

/** Verify a Stripe-Signature header (v1 scheme, HMAC-SHA256 of `${t}.${body}`). */
export function verifyStripeSignature(body: string, header: string | null, secret: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
