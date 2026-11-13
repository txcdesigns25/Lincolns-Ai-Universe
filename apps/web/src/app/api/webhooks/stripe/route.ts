import { storeInboundEvent, verifyStripeSignature } from "@universe/core";
import { db } from "@/lib/db";

// Stripe -> verified revenue. Signature-checked, stored idempotently by event id.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "Stripe not configured" }, { status: 503 });
  const body = await req.text();
  if (!verifyStripeSignature(body, req.headers.get("stripe-signature"), secret)) return Response.json({ error: "Bad signature" }, { status: 400 });
  const evt = JSON.parse(body);
  await storeInboundEvent(db(), { source: "stripe", externalId: evt.id, payload: evt });
  return Response.json({ received: true });
}
