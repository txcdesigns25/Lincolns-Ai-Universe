import type { Queryable } from "./db.js";
import { PolicyDenied } from "./errors.js";

/** An agent can see a customer only if it owns it or has an approved share. */
export async function canAccessCustomer(q: Queryable, agentId: string, customerId: string): Promise<boolean> {
  const { rowCount } = await q.query(
    `SELECT 1 FROM customers c WHERE c.id = $2 AND (c.owner_agent_id = $1
       OR EXISTS (SELECT 1 FROM customer_shares s WHERE s.customer_id = c.id AND s.agent_id = $1))`,
    [agentId, customerId]);
  return (rowCount ?? 0) > 0;
}

export async function getCustomerForAgent(q: Queryable, agentId: string, customerId: string) {
  if (!(await canAccessCustomer(q, agentId, customerId)))
    throw new PolicyDenied("customer_access_denied", `${agentId} has no access to customer ${customerId}`);
  return (await q.query(`SELECT * FROM customers WHERE id = $1`, [customerId])).rows[0];
}

export async function listCustomersForAgent(q: Queryable, agentId: string) {
  const { rows } = await q.query(
    `SELECT c.id, c.name, c.company, c.status, c.sandbox, c.owner_agent_id FROM customers c
      WHERE c.owner_agent_id = $1 OR EXISTS (SELECT 1 FROM customer_shares s WHERE s.customer_id = c.id AND s.agent_id = $1)
      ORDER BY c.created_at DESC LIMIT 100`, [agentId]);
  return rows;
}
