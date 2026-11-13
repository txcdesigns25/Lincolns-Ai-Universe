import { storeInboundEvent, AGENT_BY_ID } from "@universe/core";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";

// Public endpoint for landing-page forms. Stores the lead as an inbound event;
// the worker turns it into a customer record and a high-priority agent task.
const hits = new Map<string, number[]>();

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 5) return Response.json({ error: "Too many requests" }, { status: 429 });
  hits.set(ip, [...recent, now]);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid JSON" }, { status: 400 });
  const { agent_id, name, email, company, message, website } = body as Record<string, string>;
  if (website) return Response.json({ ok: true }); // honeypot field: silently drop bots
  if (!agent_id || !AGENT_BY_ID[agent_id] || agent_id === "ceo") return Response.json({ error: "Unknown business" }, { status: 400 });
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "Name and a valid email are required" }, { status: 400 });
  await storeInboundEvent(db(), { source: "landing_form", externalId: randomUUID(), agentId: agent_id,
    payload: { name: String(name).slice(0, 200), email: String(email).slice(0, 200), company: company ? String(company).slice(0, 200) : null, message: String(message ?? "").slice(0, 4000), consent: true } });
  return Response.json({ ok: true });
}
