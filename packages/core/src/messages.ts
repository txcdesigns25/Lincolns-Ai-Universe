import type { Queryable } from "./db.js";
import { canAccessCustomer } from "./customers.js";
import { PolicyDenied } from "./errors.js";
import { AGENT_BY_ID } from "./agents.js";

/**
 * Structured inter-agent messaging. A message that references a customer is
 * only allowed if the sender can access that customer; the receiver does NOT
 * gain access to the customer record by receiving the message (a share needs
 * owner approval).
 */
export async function sendAgentMessage(q: Queryable, m: {
  from: string; to: string; kind: "request" | "info" | "handoff" | "report"; subject: string; body: Record<string, unknown>; customerId?: string;
}) {
  if (!AGENT_BY_ID[m.to]) throw new PolicyDenied("unknown_recipient", `Unknown agent ${m.to}`);
  if (m.from === m.to) throw new PolicyDenied("self_message", "Agents cannot message themselves");
  if (m.customerId && !(await canAccessCustomer(q, m.from, m.customerId)))
    throw new PolicyDenied("customer_access_denied", "Sender cannot reference a customer it cannot access");
  const r = await q.query(
    `INSERT INTO agent_messages (from_agent_id, to_agent_id, kind, subject, body, customer_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [m.from, m.to, m.kind, m.subject, JSON.stringify(m.body), m.customerId ?? null]);
  return r.rows[0].id as string;
}

export async function inbox(q: Queryable, agentId: string, limit = 10) {
  const { rows } = await q.query(
    `SELECT id, from_agent_id, kind, subject, body, created_at FROM agent_messages
      WHERE to_agent_id = $1 AND read_at IS NULL ORDER BY created_at LIMIT $2`, [agentId, limit]);
  return rows;
}
