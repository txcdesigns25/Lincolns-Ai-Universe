import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { LlmClient, MessageParam, Tier } from "./llm.js";
import { estimateMaxCostCents, costCents } from "./llm.js";
import { authorizeSpend, settleSpend, releaseSpend, setBudget } from "./budget.js";
import { authorizeAction } from "./approvals.js";
import { assertAgentMayAct } from "./controls.js";
import { AGENT_BY_ID } from "./agents.js";
import { toolDefsFor, executeTool } from "./tools/index.js";
import { PolicyDenied } from "./errors.js";
import { audit } from "./audit.js";
import { getActiveConfig } from "./strategy.js";
import { inbox } from "./messages.js";
import { searchMemory } from "./memory.js";
import { executeExternal } from "./integrations.js";
import { notify } from "./notify.js";
import type { TaskRow } from "./queue.js";

export const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? 8);

export interface EngineDeps { db: Db; llm: LlmClient; workerId: string }

const LLM_TASKS = new Set(["growth_cycle", "performance_review", "daily_summary", "portfolio_evaluation", "directive", "inbound_lead"]);

export async function runTask(deps: EngineDeps, task: TaskRow): Promise<unknown> {
  if (task.type === "execute_action") return executeApprovedAction(deps, task);
  if (task.type === "health_check") return healthCheck(deps.db);
  if (LLM_TASKS.has(task.type)) return runAgentTask(deps, task);
  throw new PolicyDenied("unknown_task_type", `No handler for task type ${task.type}`);
}

// ───────────────────────── Prompts ─────────────────────────

const HARD_RULES = `Operating rules (enforced by the platform; you cannot change them):
- You can only act through the tools provided. Anything that reaches the outside world (publishing, sending, spending) needs pre-authorization or a human approval, which the tools handle.
- Never invent revenue, results, customers, or data. Distinguish observations, hypotheses, and verified results.
- Follow platform rules, anti-spam and privacy law. No scraping private data, no bulk unsolicited messages, no impersonating humans, no fake reviews, no manipulative SEO.
- Prefer sustainable revenue, customer satisfaction, and verified net profit over vanity metrics.
- Every model call costs money from your budget. Do useful work, then stop. Do not chat.`;

const TASK_PROMPTS: Record<string, string> = {
  growth_cycle: `Run one autonomous growth cycle: RESEARCH -> PLAN -> EXECUTE -> MEASURE -> LEARN -> OPTIMIZE.
1. Review: check your financials, experiments, recent memories, inbox, and customers.
2. Identify the single biggest problem or opportunity for verified profit.
3. Generate 2-4 improvement ideas; rank them by expected benefit vs cost; check memory so you do not repeat failed ideas without a new reason.
4. Act on the best idea within your permissions: create drafts (listings, landing pages, articles, scripts, proposals), propose a controlled experiment, submit finished drafts, or hand work to another agent.
5. Record what you learned (observations, hypotheses, mistakes) and conclude experiments that have enough data.
6. If a change to your own strategy/playbook is clearly supported by evidence, propose a strategy update.
Finish with a 3-6 sentence summary of what you did and what should happen next.`,
  performance_review: `Do a performance review of your business. Compare verified results against your success metric, review experiments (conclude or abandon where appropriate, write lessons), identify failing strategies, and record findings. Propose a strategy update only if evidence supports it. Finish with a concise review.`,
  daily_summary: `Produce today's portfolio summary. Use get_portfolio_report. Report verified revenue, expenses, net profit, notable activity, failures, and pending approvals per business. Flag risks. Recommend (do not make) any budget reallocations. Save the summary as a 'report' draft. Be factual: if there is no verified revenue, say so.`,
  portfolio_evaluation: `Evaluate all seven businesses using verified profitability, operating costs, reliability, and customer satisfaction. Identify which strategies are working and failing (only with supporting data), assign follow-up tasks to business agents where useful, and recommend budget changes through recommend_budget_change if justified. Save the evaluation as a 'report' draft.`,
  directive: `Complete the assigned task described in the payload. Stay within your tools and permissions.`,
  inbound_lead: `A new inbound lead arrived (details in the payload). Qualify it, record an observation, and draft a helpful, personalized reply (support_reply or proposal). Submit it only if appropriate; it will go through approval unless pre-authorized.`,
};

async function buildSystemPrompt(db: Db, agentId: string) {
  const def = AGENT_BY_ID[agentId];
  const cfg = await getActiveConfig(db, agentId);
  return [
    `You are ${def.name} (${def.code}), an autonomous AI worker inside AI Universe, a business operating system run for a single owner.`,
    `Mission: ${def.mission}`,
    `Responsibilities:\n- ${def.responsibilities.join("\n- ")}`,
    `Success metric: ${def.successMetric}`,
    HARD_RULES,
    cfg ? `Your current strategy (version ${cfg.version}):\n${cfg.strategy_prompt || "(none yet)"}\nPlaybook: ${JSON.stringify(cfg.playbook)}` : "You have no saved strategy yet. Develop one from evidence and propose it with propose_strategy_update.",
  ].join("\n\n");
}

async function buildTaskMessage(db: Db, task: TaskRow) {
  const [mail, memories] = await Promise.all([inbox(db, task.agent_id, 5), searchMemory(db, task.agent_id, "", 6)]);
  return [
    `Task: ${task.title} (type ${task.type}, id ${task.id})`,
    TASK_PROMPTS[task.type] ?? "",
    Object.keys(task.payload ?? {}).length ? `Payload:\n${JSON.stringify(task.payload, null, 2)}` : "",
    mail.length ? `Unread messages from other agents:\n${JSON.stringify(mail, null, 2)}` : "",
    memories.length ? `Most recent memories:\n${memories.map((m: any) => `- [${m.kind}] ${m.title}: ${String(m.content).slice(0, 300)}`).join("\n")}` : "",
    `Current time: ${new Date().toISOString()}`,
  ].filter(Boolean).join("\n\n");
}

// ───────────────────────── Agent loop ─────────────────────────

function callKey(taskId: string, tool: string, input: unknown) {
  return createHash("sha256").update(`${taskId}|${tool}|${JSON.stringify(input)}`).digest("hex");
}

/**
 * Which model tier a task gets. Decided by code, never by the agent, so an
 * agent cannot escalate itself. Important = the owner boosted this agent,
 * the owner flagged this task, or a real customer is waiting (inbound lead).
 * Escalated calls still go through every budget cap.
 */
export async function tierForTask(db: Db, task: TaskRow): Promise<Tier> {
  const agent = (await db.query(`SELECT boost FROM agents WHERE id = $1`, [task.agent_id])).rows[0];
  if (agent?.boost) return "important";
  if (task.type === "inbound_lead") return "important";
  if ((task.payload as any)?.important === true && task.created_by === "owner") return "important";
  return "routine";
}

async function runAgentTask({ db, llm, workerId }: EngineDeps, task: TaskRow) {
  await assertAgentMayAct(db, task.agent_id);
  const tier = await tierForTask(db, task);
  const tc = llm.tierConfig(tier);
  const def = AGENT_BY_ID[task.agent_id];
  if (!def) throw new PolicyDenied("unknown_agent", task.agent_id);
  const tools = toolDefsFor(def.tools);
  const system = await buildSystemPrompt(db, task.agent_id);
  const messages: MessageParam[] = [{ role: "user", content: await buildTaskMessage(db, task) }];
  let totalCost = 0;
  let settledCents = 0;
  const toolLog: { tool: string; ok: boolean; summary: string }[] = [];
  let finalText = "";
  let stop: string | null = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const req = { system, messages, tools, tier };
    // 1. Reserve budget for the worst case BEFORE calling the model.
    const reserve = llm.provider === "mock" ? 1 : estimateMaxCostCents(tc.model, tc.maxTokens, req);
    const authId = await authorizeSpend(db, {
      agentId: task.agent_id, category: "ai_api", amountCents: reserve, taskId: task.id,
      reason: `${tc.model} (${tier}) call for task ${task.type}`, idempotencyKey: `llm:${task.id}:${task.attempts}:${turn}`,
    });
    let res;
    try {
      res = await llm.create(req);
    } catch (err) {
      await releaseSpend(db, authId);
      throw err;
    }
    // 2. Settle the actual cost into the ledger. Cheap calls cost a fraction of
    // a cent, so carry the fraction across turns instead of rounding every call
    // up to a whole cent; the task's last call settles the rounded-up remainder.
    const actual = llm.provider === "mock" ? 0 : costCents(res.model, res.usage);
    totalCost += actual;
    const hasTools = res.content.some((b: any) => b.type === "tool_use");
    const isLast = turn === MAX_TURNS - 1 || !(res.stop_reason === "pause_turn" || (res.stop_reason === "tool_use" && hasTools));
    const due = (isLast ? Math.ceil(totalCost - 1e-9) : Math.floor(totalCost)) - settledCents;
    settledCents += Math.max(0, due);
    await settleSpend(db, authId, Math.max(0, due), {
      source: llm.provider === "mock" ? "sandbox" : "anthropic_usage", sandbox: llm.provider === "mock",
      description: `${res.model}: ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens (task ${task.id})`,
    });

    stop = res.stop_reason;
    messages.push({ role: "assistant", content: res.content as any });
    finalText = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim() || finalText;

    if (stop === "refusal") break;
    if (stop === "pause_turn") continue;
    const uses = res.content.filter((b: any) => b.type === "tool_use") as any[];
    if (stop !== "tool_use" || uses.length === 0) break;

    // 3. Run every tool call through the gate; journal for idempotency.
    const results = [];
    for (const u of uses) {
      const key = callKey(task.id, u.name, u.input);
      const cached = (await db.query(`SELECT output, is_error FROM tool_calls WHERE call_key = $1`, [key])).rows[0];
      let output: unknown, isError = false;
      if (cached) { output = cached.output; isError = cached.is_error; }
      else {
        try {
          output = await executeTool({ db, agentId: task.agent_id, taskId: task.id }, def.tools, u.name, u.input);
        } catch (err) {
          if (!(err instanceof PolicyDenied)) throw err;     // infrastructure error -> task retry
          isError = true; output = { error: err.code, message: err.message };
        }
        await db.query(`INSERT INTO tool_calls (task_id, agent_id, call_key, tool, input, output, is_error) VALUES ($1,$2,$3,$4,$5,$6,$7)
                        ON CONFLICT (call_key) DO NOTHING`, [task.id, task.agent_id, key, u.name, JSON.stringify(u.input ?? {}), JSON.stringify(output ?? null), isError]);
      }
      toolLog.push({ tool: u.name, ok: !isError, summary: JSON.stringify(output).slice(0, 200) });
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(output), is_error: isError });
    }
    messages.push({ role: "user", content: results as any });
  }

  await db.query(`UPDATE tasks SET cost_cents = cost_cents + $2 WHERE id = $1`, [task.id, Math.ceil(totalCost)]);
  await db.query(`UPDATE agent_messages SET read_at = now() WHERE to_agent_id = $1 AND read_at IS NULL`, [task.agent_id]);
  await audit(db, { actor: workerId, agentId: task.agent_id, action: `task.${task.type}`, outcome: "info",
    details: { stop_reason: stop, tools: toolLog.length, cost_cents: Math.ceil(totalCost), model: tc.model, tier }, taskId: task.id });
  return { summary: finalText.slice(0, 4000), stop_reason: stop, tool_calls: toolLog, cost_cents: Math.ceil(totalCost), model: tc.model, tier };
}

// ───────────────────────── Deterministic executors ─────────────────────────

async function executeApprovedAction({ db }: EngineDeps, task: TaskRow) {
  const { action, approval_id, draft_id } = task.payload as { action: string; approval_id?: string; draft_id?: string };
  const agent = (await db.query(`SELECT live_mode FROM agents WHERE id = $1`, [task.agent_id])).rows[0];
  const live = !!agent?.live_mode;

  if (action === "budget.change") {
    // The owner approved this exact change; apply it on the owner's authority.
    const a = (await db.query(`SELECT * FROM approvals WHERE id = $1`, [approval_id])).rows[0];
    await authorizeAction(db, { agentId: task.agent_id, action, approvalId: approval_id, taskId: task.id });
    await setBudget(db, a.details.target_agent_id, a.details.limits_cents, "owner");
    return { applied: a.details.limits_cents, target: a.details.target_agent_id };
  }

  if (!draft_id) {
    // Purchases, contracts, refunds, etc. have no automated executor. Hand back to the owner.
    await authorizeAction(db, { agentId: task.agent_id, action, approvalId: approval_id, taskId: task.id, sandbox: true });
    await notify(db, { severity: "info", agentId: task.agent_id, title: `Approved action needs manual execution: ${action}`,
      body: `Approval ${approval_id} was approved. No automated integration exists for ${action}; complete it manually.`, dedupeKey: `manual:${approval_id}` });
    return { manual: true, action };
  }

  const draft = (await db.query(`SELECT * FROM drafts WHERE id = $1`, [draft_id])).rows[0];
  if (!draft || draft.agent_id !== task.agent_id) throw new PolicyDenied("draft_mismatch", "Draft missing or belongs to another agent");
  if (draft.status === "published") return { already_published: draft.published_ref };   // idempotent
  await authorizeAction(db, { agentId: task.agent_id, action, approvalId: approval_id, taskId: task.id, sandbox: !live });
  const result = await executeExternal(action, draft, live);
  await withTx(db, async (tx) => {
    await tx.query(`UPDATE drafts SET status = 'published', published_ref = $2, sandbox_publish = $3, updated_at = now() WHERE id = $1`,
      [draft_id, result.ref, result.sandbox]);
    await audit(tx, { actor: task.agent_id, agentId: task.agent_id, action: `execute.${action}`, outcome: "allowed", details: result, taskId: task.id });
  });
  return result;
}

/** Hourly, no LLM: find problems that need a human and raise notifications. */
export async function healthCheck(db: Db) {
  const issues: string[] = [];
  const dead = (await db.query(`SELECT id, agent_id, title, last_error FROM tasks WHERE status = 'dead' AND finished_at > now() - interval '1 day'`)).rows;
  for (const t of dead) {
    issues.push(`dead:${t.id}`);
    await notify(db, { severity: "warning", agentId: t.agent_id, title: `Task failed permanently: ${t.title}`, body: t.last_error ?? "", dedupeKey: `dead:${t.id}` });
  }
  const near = (await db.query(
    `SELECT b.agent_id, b.monthly_limit,
            COALESCE(SUM(CASE WHEN s.status='settled' THEN s.settled_cents ELSE s.amount_cents END),0) AS used
       FROM agent_budgets b LEFT JOIN spend_authorizations s ON s.agent_id = b.agent_id
            AND s.status IN ('reserved','settled') AND s.created_at >= date_trunc('month', now())
      GROUP BY b.agent_id, b.monthly_limit HAVING b.monthly_limit > 0
         AND COALESCE(SUM(CASE WHEN s.status='settled' THEN s.settled_cents ELSE s.amount_cents END),0) >= 0.8 * b.monthly_limit`)).rows;
  for (const n of near) {
    issues.push(`budget:${n.agent_id}`);
    await notify(db, { severity: "warning", agentId: n.agent_id, title: `Agent at ${Math.round((100 * n.used) / n.monthly_limit)}% of monthly budget`,
      body: `${n.used} of ${n.monthly_limit} cents used this month.`, dedupeKey: `budget80:${n.agent_id}:${new Date().toISOString().slice(0, 7)}` });
  }
  const errored = (await db.query(`SELECT id FROM agents WHERE status = 'error'`)).rows;
  for (const a of errored) {
    issues.push(`agent_error:${a.id}`);
    await notify(db, { severity: "critical", agentId: a.id, title: `Agent ${a.id} is in error state`, dedupeKey: `agent_error:${a.id}:${new Date().toISOString().slice(0, 10)}` });
  }
  const pendingOld = (await db.query(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending' AND created_at < now() - interval '2 days'`)).rows[0].n;
  if (pendingOld) await notify(db, { severity: "info", title: `${pendingOld} approvals waiting more than 2 days`, dedupeKey: `stale-approvals:${new Date().toISOString().slice(0, 10)}` });
  await db.query(`UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`);
  return { issues };
}
