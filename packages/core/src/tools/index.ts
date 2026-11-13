import { z } from "zod";
import type { Db, Queryable } from "../db.js";
import { recordMemory, searchMemory, concludeExperiment, findSimilarExperiments } from "../memory.js";
import { sendAgentMessage } from "../messages.js";
import { listCustomersForAgent, canAccessCustomer } from "../customers.js";
import { getFinancials } from "../ledger.js";
import { requestApproval, authorizeAction } from "../approvals.js";
import { enqueue } from "../queue.js";
import { getAction } from "../policy.js";
import { notify } from "../notify.js";
import { PolicyDenied } from "../errors.js";
import { AGENTS, AGENT_BY_ID } from "../agents.js";
import { getSpendSummary } from "../budget.js";
import { proposeConfigVersion } from "../strategy.js";
import type { ToolDef } from "../llm.js";

export interface ToolContext {
  db: Db;
  agentId: string;
  taskId: string;
}

export interface ToolSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Policy action this tool performs. Checked by the engine before the handler runs. */
  action: string;
  schema: S;
  handler: (ctx: ToolContext, input: z.infer<S>) => Promise<unknown>;
}

function tool<S extends z.ZodTypeAny>(t: ToolSpec<S>): ToolSpec<S> { return t; }

const DRAFT_TYPES = ["product_listing", "proposal", "outreach", "short_form_script", "landing_page", "seo_article", "ad_copy", "support_reply", "report", "other"] as const;

/** Which publishing action a draft type needs. */
const PUBLISH_ACTION: Record<string, string> = {
  product_listing: "listing.publish",
  outreach: "outreach.send",
  proposal: "outreach.send",
  short_form_script: "content.publish_approved",
  seo_article: "website.update_owned",
  landing_page: "website.update_owned",
  ad_copy: "ads.launch",
  support_reply: "customer.routine_request",
};

export const TOOLS: ToolSpec[] = [
  tool({
    name: "record_memory",
    description: "Save something to your persistent memory. Use 'observation' for facts you saw, 'hypothesis' for ideas not yet tested, 'mistake' for errors to avoid, 'strategy' for approaches you plan to use. 'verified_result' is only accepted with evidence that exists in the database (a ledger entry id, a concluded experiment id, or a task id).",
    action: "memory.write",
    schema: z.object({
      kind: z.enum(["observation", "hypothesis", "verified_result", "mistake", "strategy", "customer_feedback"]),
      title: z.string().min(3).max(200),
      content: z.string().min(1).max(5000),
      tags: z.array(z.string().max(40)).max(10).optional(),
      confidence: z.number().min(0).max(1).optional(),
      evidence: z.array(z.object({ type: z.enum(["ledger_entry", "experiment", "task", "external_report"]), ref: z.string(), note: z.string().optional() })).optional(),
    }),
    handler: async (ctx, i) => ({ memory_id: await recordMemory(ctx.db, { ...i, agentId: ctx.agentId, taskId: ctx.taskId }) }),
  }),
  tool({
    name: "search_memory",
    description: "Search your own past memories (observations, hypotheses, results, mistakes). Use before proposing work to avoid repeating failed approaches.",
    action: "research.public",
    schema: z.object({ query: z.string().max(200), limit: z.number().int().min(1).max(20).optional() }),
    handler: async (ctx, i) => ({ memories: await searchMemory(ctx.db, ctx.agentId, i.query, i.limit ?? 8) }),
  }),
  tool({
    name: "create_draft",
    description: "Create a draft deliverable (product listing, proposal, outreach message, script, landing page, SEO article, ad copy, support reply, report). Drafts are internal; nothing is published or sent.",
    action: "draft.create",
    schema: z.object({
      draft_type: z.enum(DRAFT_TYPES),
      title: z.string().min(3).max(200),
      body: z.string().min(1).max(20000),
      metadata: z.record(z.string(), z.unknown()).optional(),
      customer_id: z.string().uuid().optional(),
      experiment_id: z.string().uuid().optional(),
    }),
    handler: async (ctx, i) => {
      if (i.customer_id && !(await canAccessCustomer(ctx.db, ctx.agentId, i.customer_id)))
        throw new PolicyDenied("customer_access_denied", "You cannot reference that customer");
      const r = await ctx.db.query(
        `INSERT INTO drafts (agent_id, draft_type, title, body, metadata, customer_id, experiment_id, task_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.agentId, i.draft_type, i.title, i.body, JSON.stringify(i.metadata ?? {}), i.customer_id ?? null, i.experiment_id ?? null, ctx.taskId]);
      return { draft_id: r.rows[0].id, status: "draft" };
    },
  }),
  tool({
    name: "submit_draft",
    description: "Submit one of your drafts for publication/sending. If the action is pre-authorized for you, it is queued for execution; otherwise a human approval request is created. You cannot publish directly.",
    action: "draft.create",
    schema: z.object({ draft_id: z.string().uuid(), justification: z.string().min(10).max(2000) }),
    handler: async (ctx, i) => {
      const d = (await ctx.db.query(`SELECT * FROM drafts WHERE id = $1 AND agent_id = $2`, [i.draft_id, ctx.agentId])).rows[0];
      if (!d) throw new PolicyDenied("not_found", "Draft not found or not yours");
      if (d.status !== "draft") return { status: d.status, approval_id: d.approval_id };
      const action = PUBLISH_ACTION[d.draft_type];
      if (!action) throw new PolicyDenied("not_publishable", `${d.draft_type} drafts are internal only`);
      const spec = getAction(action);
      if (spec.level === 2) {
        const perm = await ctx.db.query(`SELECT 1 FROM agent_permissions WHERE agent_id = $1 AND action = $2`, [ctx.agentId, action]);
        if (perm.rowCount) {
          await ctx.db.query(`UPDATE drafts SET status = 'approved', updated_at = now() WHERE id = $1`, [d.id]);
          const t = await enqueue(ctx.db, { agentId: ctx.agentId, type: "execute_action", title: `Publish draft: ${d.title}`,
            payload: { action, draft_id: d.id }, priority: 3, idempotencyKey: `publish:${d.id}`, createdBy: ctx.agentId, parentTaskId: ctx.taskId });
          return { status: "queued_for_execution", action, task_id: t.id };
        }
      }
      const a = await requestApproval(ctx.db, {
        agentId: ctx.agentId, action, taskId: ctx.taskId, summary: `Publish ${d.draft_type.replace("_", " ")}: ${d.title}`,
        details: { draft_id: d.id, justification: i.justification }, idempotencyKey: `draft-approval:${d.id}`,
      });
      await ctx.db.query(`UPDATE drafts SET status = 'pending_approval', approval_id = $2, updated_at = now() WHERE id = $1`, [d.id, a.id]);
      return { status: "pending_approval", action, approval_id: a.id };
    },
  }),
  tool({
    name: "send_agent_message",
    description: "Send a structured message to another agent (e.g. hand off an SEO opportunity to seo_agency). Recipients do not gain access to your customers' records.",
    action: "message.agent",
    schema: z.object({
      to: z.enum(AGENTS.map((a) => a.id) as [string, ...string[]]),
      kind: z.enum(["request", "info", "handoff", "report"]),
      subject: z.string().min(3).max(200),
      body: z.record(z.string(), z.unknown()),
      customer_id: z.string().uuid().optional(),
    }),
    handler: async (ctx, i) => ({ message_id: await sendAgentMessage(ctx.db, { from: ctx.agentId, ...i }) }),
  }),
  tool({
    name: "tell_owner_blocked",
    description: "Message the owner on Telegram ONLY when you are blocked on something only they can provide: an account or login, access to a service, a file, or a decision that is theirs. Never use it for ideas, opinions, status updates or permission you can get through request_approval; decide and learn from results yourself. Limited to 2 per day.",
    action: "owner.notify",
    schema: z.object({
      need: z.string().min(10).max(300).describe("Exactly what you need from the owner, in one or two plain sentences"),
      why: z.string().min(10).max(500).describe("What it unblocks"),
    }),
    handler: async (ctx, i) => {
      const day = new Date().toISOString().slice(0, 10);
      const sent = (await ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE $1`, [`blocked:${ctx.agentId}:${day}:%`])).rows[0].n;
      if (sent >= 2) throw new PolicyDenied("owner_notify_limit", "Already messaged the owner twice today; record the blocker in memory and work on something else");
      await notify(ctx.db, { severity: "warning", agentId: ctx.agentId, title: `${AGENT_BY_ID[ctx.agentId]?.name ?? ctx.agentId} needs you: ${i.need}`,
        body: `Why: ${i.why}\nReply with: ${ctx.agentId === "ceo" ? "" : "/ask " + ctx.agentId + " "}<your answer>`, dedupeKey: `blocked:${ctx.agentId}:${day}:${sent + 1}` });
      return { sent: true, remaining_today: 1 - sent };
    },
  }),
  tool({
    name: "propose_experiment",
    description: "Propose a controlled experiment (e.g. two product descriptions, two landing page headlines). Must include a measurable metric tied to verified outcomes (conversions, revenue), not vanity metrics. Similar past experiments are checked; repeating a failed one requires a justification.",
    action: "experiment.propose",
    schema: z.object({
      hypothesis: z.string().min(10).max(1000),
      strategy: z.string().min(10).max(2000),
      metric: z.string().min(3).max(200),
      channel: z.enum(["seo", "short_form", "landing_page", "email_followup", "product_page", "pricing", "proposal", "retention", "other"]),
      variants: z.array(z.object({ name: z.string().max(40), description: z.string().max(2000) })).length(2),
      expected_benefit: z.number().min(0).max(10),
      expected_cost_cents: z.number().int().min(0),
      min_sample_size: z.number().int().min(30).max(100000).optional(),
      repeat_justification: z.string().max(2000).optional(),
    }),
    handler: async (ctx, i) => {
      const similar = await findSimilarExperiments(ctx.db, ctx.agentId, i.hypothesis);
      const failed = similar.filter((s: any) => s.status === "abandoned" || s.status === "concluded");
      if (failed.length && !i.repeat_justification)
        return { status: "rejected_duplicate", similar_experiments: failed, hint: "Provide repeat_justification explaining what is meaningfully different." };
      const r = await ctx.db.query(
        `INSERT INTO experiments (agent_id, hypothesis, strategy, metric, channel, variants, expected_benefit, expected_cost_cents, min_sample_size, results)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [ctx.agentId, i.hypothesis, i.strategy, i.metric, i.channel, JSON.stringify(i.variants), i.expected_benefit, i.expected_cost_cents,
         i.min_sample_size ?? 100, JSON.stringify(Object.fromEntries(i.variants.map((v) => [v.name, { trials: 0, conversions: 0 }])))]);
      return { experiment_id: r.rows[0].id, status: "proposed", note: "Results are recorded from verified data by the system, not by agents." };
    },
  }),
  tool({
    name: "review_experiments",
    description: "List your experiments with their current results (recorded by the system from verified data) and status.",
    action: "report.financial",
    schema: z.object({ status: z.enum(["proposed", "running", "concluded", "abandoned"]).optional() }),
    handler: async (ctx, i) => {
      const scope = ctx.agentId === "ceo" ? "TRUE" : "agent_id = $1";
      const params: unknown[] = ctx.agentId === "ceo" ? [] : [ctx.agentId];
      if (i.status) params.push(i.status);
      const { rows } = await ctx.db.query(
        `SELECT id, agent_id, hypothesis, metric, channel, status, results, winner, conclusion, lessons, cost_cents, min_sample_size
           FROM experiments WHERE ${scope} ${i.status ? `AND status = $${params.length}` : ""} ORDER BY created_at DESC LIMIT 25`, params);
      return { experiments: rows };
    },
  }),
  tool({
    name: "conclude_experiment",
    description: "Ask the system to evaluate a running experiment with a two-proportion significance test. It will refuse to declare a winner without enough data.",
    action: "experiment.propose",
    schema: z.object({ experiment_id: z.string().uuid() }),
    handler: async (ctx, i) => {
      const own = await ctx.db.query(`SELECT 1 FROM experiments WHERE id = $1 AND agent_id = $2`, [i.experiment_id, ctx.agentId]);
      if (!own.rowCount) throw new PolicyDenied("not_found", "Experiment not found or not yours");
      return concludeExperiment(ctx.db, i.experiment_id);
    },
  }),
  tool({
    name: "record_experiment_lesson",
    description: "Write the lessons learned for one of your experiments (works for successes and failures). Optionally abandon it.",
    action: "memory.write",
    schema: z.object({ experiment_id: z.string().uuid(), lessons: z.string().min(10).max(5000), abandon: z.boolean().optional() }),
    handler: async (ctx, i) => {
      const r = await ctx.db.query(
        `UPDATE experiments SET lessons = $3, status = CASE WHEN $4 AND status <> 'concluded' THEN 'abandoned' ELSE status END
          WHERE id = $1 AND agent_id = $2 RETURNING status`, [i.experiment_id, ctx.agentId, i.lessons, i.abandon ?? false]);
      if (!r.rowCount) throw new PolicyDenied("not_found", "Experiment not found or not yours");
      return { status: r.rows[0].status };
    },
  }),
  tool({
    name: "request_approval",
    description: "Ask the human owner to approve a high-impact action: purchase/subscription, paid advertising, contract, significant refund, access to sensitive data, production deploy. Include the amount in cents if money is involved.",
    action: "draft.create",
    schema: z.object({
      action: z.enum(["purchase.new", "ads.launch", "contract.enter", "refund.significant", "data.access_sensitive", "deploy.production"]),
      summary: z.string().min(10).max(300),
      details: z.record(z.string(), z.unknown()),
      amount_cents: z.number().int().positive().optional(),
    }),
    handler: async (ctx, i) => {
      const a = await requestApproval(ctx.db, { agentId: ctx.agentId, taskId: ctx.taskId, action: i.action, summary: i.summary,
        details: i.details, amountCents: i.amount_cents, idempotencyKey: `req:${ctx.taskId}:${i.action}:${i.summary}` });
      return { approval_id: a.id, status: "pending", note: "Nothing happens until the owner approves." };
    },
  }),
  tool({
    name: "propose_strategy_update",
    description: "Propose a new version of your own strategy prompt, playbook (channels, content strategy, cadence notes), or growth-cycle interval. Versions are reversible. You cannot change tools, permissions, or budgets.",
    action: "experiment.propose",
    schema: z.object({
      strategy_prompt: z.string().max(8000).optional(),
      playbook: z.record(z.string(), z.unknown()).optional(),
      cycle_interval_minutes: z.number().int().min(60).max(10080).optional(),
      rationale: z.string().min(20).max(3000),
      evidence: z.array(z.object({ type: z.string(), ref: z.string() })).optional(),
    }),
    handler: async (ctx, i) => proposeConfigVersion(ctx.db, { agentId: ctx.agentId, proposedBy: ctx.agentId, ...i }),
  }),
  tool({
    name: "get_own_financials",
    description: "Get your verified financials (revenue, refunds, fees, costs, net profit) and current spend versus limits.",
    action: "report.financial",
    schema: z.object({}),
    handler: async (ctx) => {
      const [fin, spend, limits] = await Promise.all([
        getFinancials(ctx.db, { agentId: ctx.agentId }),
        getSpendSummary(ctx.db, ctx.agentId),
        ctx.db.query(`SELECT * FROM agent_budgets WHERE agent_id = $1`, [ctx.agentId]),
      ]);
      return { verified_financials_cents: fin, spend_cents: spend, limits_cents: limits.rows[0] ?? null };
    },
  }),
  tool({
    name: "list_own_customers",
    description: "List customers and leads you own or that were explicitly shared with you.",
    action: "report.financial",
    schema: z.object({}),
    handler: async (ctx) => ({ customers: await listCustomersForAgent(ctx.db, ctx.agentId) }),
  }),
  tool({
    name: "schedule_follow_up",
    description: "Schedule an internal follow-up task for yourself (e.g. check experiment results in 3 days).",
    action: "task.schedule_internal",
    schema: z.object({ title: z.string().min(3).max(200), instructions: z.string().max(4000), delay_hours: z.number().min(1).max(24 * 30) }),
    handler: async (ctx, i) => {
      const t = await enqueue(ctx.db, { agentId: ctx.agentId, type: "directive", title: i.title, payload: { instructions: i.instructions },
        runAt: new Date(Date.now() + i.delay_hours * 3600_000), idempotencyKey: `followup:${ctx.taskId}:${i.title}`, createdBy: ctx.agentId, parentTaskId: ctx.taskId });
      return { task_id: t.id };
    },
  }),

  // ───── CEO-only tools ─────
  tool({
    name: "get_portfolio_report",
    description: "Verified financials, spend, task health, pending approvals, and active experiments for every business.",
    action: "report.financial",
    schema: z.object({ days: z.number().int().min(1).max(365).optional() }),
    handler: async (ctx, i) => portfolioReport(ctx.db, i.days ?? 30),
  }),
  tool({
    name: "assign_task",
    description: "Assign an internal task to a business agent. The agent still operates under its own permissions and budget.",
    action: "task.assign",
    schema: z.object({
      agent_id: z.enum(AGENTS.filter((a) => a.kind === "business").map((a) => a.id) as [string, ...string[]]),
      title: z.string().min(3).max(200),
      instructions: z.string().min(10).max(4000),
      priority: z.number().int().min(1).max(9).optional(),
    }),
    handler: async (ctx, i) => {
      const t = await enqueue(ctx.db, { agentId: i.agent_id, type: "directive", title: i.title, payload: { instructions: i.instructions, from: "ceo" },
        priority: i.priority ?? 5, idempotencyKey: `assign:${ctx.taskId}:${i.agent_id}:${i.title}`, createdBy: "ceo", parentTaskId: ctx.taskId });
      return { task_id: t.id };
    },
  }),
  tool({
    name: "recommend_budget_change",
    description: "Recommend new budget limits for a business agent. Creates an approval request for the owner; does not change anything by itself.",
    action: "draft.create",
    schema: z.object({
      agent_id: z.enum(AGENTS.filter((a) => a.kind === "business").map((a) => a.id) as [string, ...string[]]),
      limits_cents: z.object({
        daily_limit: z.number().int().min(0).optional(), weekly_limit: z.number().int().min(0).optional(),
        monthly_limit: z.number().int().min(0).optional(), per_transaction_limit: z.number().int().min(0).optional(),
        ai_monthly_limit: z.number().int().min(0).optional(), ads_monthly_limit: z.number().int().min(0).optional(),
      }),
      rationale: z.string().min(20).max(3000),
    }),
    handler: async (ctx, i) => {
      const a = await requestApproval(ctx.db, { agentId: "ceo", taskId: ctx.taskId, action: "budget.change",
        summary: `CEO recommends budget change for ${AGENT_BY_ID[i.agent_id].name}`,
        details: { target_agent_id: i.agent_id, limits_cents: i.limits_cents, rationale: i.rationale },
        idempotencyKey: `budget:${ctx.taskId}:${i.agent_id}` });
      return { approval_id: a.id, status: "pending_owner_decision" };
    },
  }),
];

export const TOOL_BY_NAME: Record<string, ToolSpec> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Tool definitions for the Claude API, restricted to what this agent is allowed. */
export function toolDefsFor(allowed: string[]): ToolDef[] {
  return allowed.map((n) => TOOL_BY_NAME[n]).filter(Boolean).map((t) => {
    const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema as ToolDef["input_schema"] };
  });
}

export async function portfolioReport(q: Queryable, days: number) {
  const since = new Date(Date.now() - days * 86400_000);
  const agents = (await q.query(`SELECT id, name, status, live_mode FROM agents ORDER BY code`)).rows;
  const out = [];
  for (const a of agents) {
    const [fin, spend, tasks, exps] = await Promise.all([
      getFinancials(q, { agentId: a.id, since }),
      getSpendSummary(q, a.id),
      q.query(`SELECT status, count(*)::int AS n FROM tasks WHERE agent_id = $1 AND created_at >= $2 GROUP BY status`, [a.id, since]),
      q.query(`SELECT count(*) FILTER (WHERE status = 'running')::int AS running, count(*) FILTER (WHERE status = 'concluded')::int AS concluded FROM experiments WHERE agent_id = $1`, [a.id]),
    ]);
    out.push({ ...a, verified_financials_cents: fin, spend_cents: spend,
      tasks: Object.fromEntries(tasks.rows.map((r) => [r.status, r.n])), experiments: exps.rows[0] });
  }
  const pending = (await q.query(`SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'`)).rows[0].n;
  return { period_days: days, agents: out, pending_approvals: pending,
    note: "Financials include only verified, non-sandbox ledger entries." };
}

/** Gate + execute one tool call. Returns a JSON-able result or throws PolicyDenied. */
export async function executeTool(ctx: ToolContext, allowed: string[], name: string, rawInput: unknown) {
  if (!allowed.includes(name)) throw new PolicyDenied("tool_not_allowed", `Tool ${name} is not available to ${ctx.agentId}`);
  const spec = TOOL_BY_NAME[name];
  if (!spec) throw new PolicyDenied("unknown_tool", `Unknown tool ${name}`);
  const parsed = spec.schema.safeParse(rawInput);
  if (!parsed.success) throw new PolicyDenied("invalid_input", `Invalid input for ${name}: ${parsed.error.message.slice(0, 800)}`);
  await authorizeAction(ctx.db, { agentId: ctx.agentId, action: spec.action, taskId: ctx.taskId });
  return spec.handler(ctx, parsed.data);
}
