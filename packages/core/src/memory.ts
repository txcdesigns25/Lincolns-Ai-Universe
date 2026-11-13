import type { Queryable } from "./db.js";
import { PolicyDenied } from "./errors.js";

export type MemoryKind = "observation" | "hypothesis" | "verified_result" | "mistake" | "strategy" | "customer_feedback";

export interface Evidence { type: "ledger_entry" | "experiment" | "task" | "external_report"; ref: string; note?: string }

/**
 * Write a memory. 'verified_result' must cite evidence that actually exists
 * in our database; agents cannot declare success without data.
 */
export async function recordMemory(q: Queryable, m: {
  agentId: string; kind: MemoryKind; title: string; content: string; tags?: string[]; confidence?: number;
  evidence?: Evidence[]; experimentId?: string; taskId?: string;
}) {
  const evidence = m.evidence ?? [];
  if (m.kind === "verified_result") {
    if (!evidence.length) throw new PolicyDenied("no_evidence", "verified_result requires evidence");
    for (const e of evidence) {
      const table = e.type === "ledger_entry" ? "ledger_entries" : e.type === "experiment" ? "experiments" : e.type === "task" ? "tasks" : null;
      if (!table) throw new PolicyDenied("weak_evidence", "verified_result needs ledger, experiment, or task evidence");
      const ok = await q.query(`SELECT 1 FROM ${table} WHERE id::text = $1 ${table === "experiments" ? "AND status = 'concluded'" : ""}`, [e.ref]);
      if (!ok.rowCount) throw new PolicyDenied("evidence_not_found", `Evidence ${e.type}:${e.ref} not found${table === "experiments" ? " or experiment not concluded" : ""}`);
    }
  }
  const r = await q.query(
    `INSERT INTO memories (agent_id, kind, title, content, tags, confidence, evidence, experiment_id, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [m.agentId, m.kind, m.title, m.content, m.tags ?? [], m.confidence ?? null, JSON.stringify(evidence), m.experimentId ?? null, m.taskId ?? null]);
  return r.rows[0].id as string;
}

/** Full-text retrieval over an agent's own memories (agents never read each other's memory directly). */
export async function searchMemory(q: Queryable, agentId: string, query: string, limit = 8) {
  const { rows } = await q.query(
    `SELECT id, kind, title, content, confidence, created_at,
            ts_rank(search, websearch_to_tsquery('english', $2)) AS rank
       FROM memories WHERE agent_id = $1 AND ($2 = '' OR search @@ websearch_to_tsquery('english', $2))
      ORDER BY rank DESC, created_at DESC LIMIT $3`, [agentId, query, limit]);
  return rows;
}

/**
 * Conclude an A/B experiment with a two-proportion z-test. Refuses to pick a
 * winner below the minimum sample size or without significance.
 */
export function evaluateExperiment(results: Record<string, { trials: number; conversions: number }>, minSample: number) {
  const entries = Object.entries(results);
  if (entries.length !== 2) return { decided: false, reason: "Exactly two variants required" } as const;
  const [[na, a], [nb, b]] = entries;
  if (a.trials < minSample || b.trials < minSample)
    return { decided: false, reason: `Insufficient sample (need ${minSample} per variant; have ${a.trials}/${b.trials})` } as const;
  const pa = a.conversions / a.trials, pb = b.conversions / b.trials;
  const p = (a.conversions + b.conversions) / (a.trials + b.trials);
  const se = Math.sqrt(p * (1 - p) * (1 / a.trials + 1 / b.trials));
  const z = se === 0 ? 0 : (pa - pb) / se;
  if (Math.abs(z) < 1.96) return { decided: false, reason: `No significant difference (z=${z.toFixed(2)})`, z } as const;
  return { decided: true, winner: z > 0 ? na : nb, z, rates: { [na]: pa, [nb]: pb } } as const;
}

export async function concludeExperiment(q: Queryable, experimentId: string) {
  const ex = (await q.query(`SELECT * FROM experiments WHERE id = $1`, [experimentId])).rows[0];
  if (!ex) throw new Error("Experiment not found");
  const verdict = evaluateExperiment(ex.results, ex.min_sample_size);
  if (!verdict.decided) return verdict;
  await q.query(`UPDATE experiments SET status = 'concluded', winner = $2, conclusion = $3, concluded_at = now() WHERE id = $1`,
    [experimentId, verdict.winner, `Winner ${verdict.winner} (z=${verdict.z.toFixed(2)})`]);
  return verdict;
}

/** Has this agent already tried (and abandoned/lost) something similar? */
export async function findSimilarExperiments(q: Queryable, agentId: string, hypothesis: string) {
  const { rows } = await q.query(
    `SELECT id, hypothesis, status, conclusion FROM experiments
      WHERE agent_id = $1 AND to_tsvector('english', hypothesis || ' ' || strategy) @@ plainto_tsquery('english', $2)
      ORDER BY created_at DESC LIMIT 5`, [agentId, hypothesis]);
  return rows;
}
