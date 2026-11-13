# AI Universe architecture

AI Universe is a business operating system: one **Universe CEO** and seven **business agents**, each with its own ledger, budget, memory, task queue, permissions and strategy. Agents do real work through tools; every action that touches money or the outside world goes through controls enforced in code and in the database, never in a prompt.

## Stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language for dashboard, API, worker and agent engine; shared types. |
| Database | PostgreSQL 16 | Ledgers need transactions and row locks; also serves as the durable queue, full-text memory search, and audit log. One stateful component instead of Postgres + Redis + a vector DB. |
| Queue | Postgres `tasks` table with `FOR UPDATE SKIP LOCKED` + leases | Durable, transactional with the ledger, survives restarts, safe with any number of workers. No extra infrastructure. |
| Reasoning | Claude API (`claude-opus-5-5`, adaptive thinking, effort `medium`) via `@anthropic-ai/sdk` | Tool use with a manual loop so every model call is budget-reserved first and every tool call passes the policy gate. A free mock LLM is used whenever no API key is set. |
| Dashboard | Next.js 15 (App Router, server components, server actions) + Tailwind 4 | Server-only data access: no API keys or DB credentials reach the browser. |
| Remote control | Telegram bot (long polling inside the worker) | Works without a public URL; owner-only. |
| Hosting | Railway: `web` service, `worker` service, managed Postgres | Persistent worker process for 24/7 operation, low cost. The same code runs locally. |

## Processes

```
                ┌──────────────┐        ┌──────────────────────────────┐
 Browser ──────▶│  web (Next)  │──SQL──▶│                              │
 Landing forms ▶│  /api/leads  │        │          PostgreSQL           │
 Stripe ───────▶│  /api/webhooks│       │  agents · budgets · ledger    │
                └──────────────┘        │  tasks (queue) · approvals    │
                                        │  memories · experiments       │
 Telegram ◀────▶┌──────────────┐        │  strategy versions · audit    │
                │    worker    │──SQL──▶│                              │
 Claude API ◀───│ scheduler     │        └──────────────────────────────┘
 Shopify  ◀─────│ event intake  │
                │ task runner   │
                │ health check  │
                └──────────────┘
```

**web**: dashboard (12 sections), owner login, server actions for owner-only controls, public lead-capture endpoint, Stripe webhook receiver. It never runs agents.

**worker**: one long-running process. Every 30s: heartbeat, recover tasks whose lease expired (crashed worker), turn due schedules into tasks, turn inbound events into tasks/ledger rows. Continuously: claim the next task and run it. Optional Telegram long-poll loop. Graceful shutdown on SIGTERM.

## How an agent runs (the engine)

1. A task is claimed from the queue with a 5-minute lease (extended while running).
2. Checks: emergency stop off, agent `active`.
3. Builds the system prompt from the agent definition, its **active strategy version**, and hard operating rules; the user message has the task, payload, unread agent messages and recent memories.
4. Loop (max 8 turns):
   - **Reserve** the worst-case cost of the next model call against the agent's budget (`authorizeSpend`). If any limit would be exceeded, the call never happens.
   - Call Claude. On a transient error the reservation is released and the task is retried with backoff.
   - **Settle** the actual token cost into the agent's ledger.
   - For each tool call: check the tool is in this agent's allowlist, validate input with zod, check the action's permission level (`authorizeAction`), run it, and journal the result in `tool_calls`. A retry of the same task with the same tool input returns the journaled result, so no side effect happens twice.
5. Result and cost are saved on the task.

Approved Level 3 actions are executed by deterministic code (`execute_action` tasks), never by the model.

## Safety controls (all enforced server-side)

| Control | Where | Behavior |
|---|---|---|
| Spending limits | `budget.ts` `authorizeSpend` | Per agent: lifetime, daily, weekly, monthly, per-transaction, AI/month, ads/month. Plus a **global $50/month cap** across all agents. Runs in a transaction holding row locks on `system_controls` and the agent's budget, counting reservations, so concurrent workers cannot overshoot (tested with 20 concurrent requests). |
| Non-AI spend | same | Any category other than `ai_api` requires an approved approval for that agent, capped at the approved amount. |
| Who can change limits | `setBudget`, `setGlobalMonthlyLimit` | Only `owner`. No agent tool reaches these functions. The CEO's `recommend_budget_change` only creates an approval request. |
| Permission levels | `policy.ts`, `approvals.ts` | L1 automatic; L2 only with an owner preauthorization row; L3 only with an approved, single-use approval bound to that agent and action. Unknown actions are treated as L3. |
| Sandbox vs live | `agents.live_mode` | External actions need live mode (owner-only toggle, typed confirmation). In sandbox, approved actions run through simulated adapters. |
| Emergency stop | `controls.ts` | Blocks every new spend authorization and agent action immediately. Telegram can engage it; only the dashboard can release it. |
| Customer data isolation | `customers.ts`, `messages.ts` | An agent sees a customer only if it owns it or has an owner-approved share. Messages referencing a customer require the sender to have access and grant the recipient nothing. |
| Memory honesty | `memory.ts` + DB CHECK | `verified_result` memories must cite evidence that exists (ledger entry, concluded experiment, task). The database rejects one with no evidence. |
| Revenue honesty | `ledger.ts` | Totals include only `verified` (Stripe/Shopify) and non-sandbox rows. The ledger and audit log are append-only (DB triggers). |
| Shopify store guard | `integrations.ts` | Before any write, asks Shopify which shop the token belongs to and refuses TXC Designs (and anything in `SHOPIFY_BLOCKED_STORES`). |
| Telegram | `telegram.ts` | Only the owner's numeric user id in a private chat. Cannot approve money/legal requests, change budgets, enable live mode, or release the stop. |

## Autonomous growth and learning

- **Proactive cycles**: every business agent has a `growth_cycle` schedule (default daily) running RESEARCH → PLAN → EXECUTE → MEASURE → LEARN → OPTIMIZE, plus a weekly `performance_review`. The CEO writes a daily summary and a weekly portfolio evaluation. An hourly `health_check` (no LLM) raises notifications for dead tasks, budgets above 80%, agents in error, and stale approvals.
- **Experiments**: hypothesis, strategy, metric, channel, two variants, expected benefit/cost, actions, costs, results, lessons. Agents cannot write results; results come from verified data. `conclude_experiment` uses a two-proportion z-test and refuses to pick a winner below the minimum sample size (default 100 per variant) or without significance (|z| ≥ 1.96). Proposing something similar to a concluded/abandoned experiment requires a written justification.
- **Versioned strategy**: agents propose new versions of their strategy prompt, playbook and cycle cadence (`agent_config_versions`). Activation is automatic only if the owner pre-authorized `strategy.self_update`; any version can be rolled back from the dashboard. Tools, permissions and budgets are not part of a version, so agents cannot touch them this way.
- **Event-driven work**: landing-page leads (`POST /api/leads`) become a customer record plus a high-priority `inbound_lead` task. Stripe `charge.succeeded`/`charge.refunded` webhooks become verified ledger entries (signature-checked, idempotent).
- **Collaboration**: `send_agent_message` (structured request/info/handoff/report), CEO `assign_task`.

## Data model (main tables)

`system_controls` (emergency stop, global cap) · `agents` · `agent_budgets` · `agent_permissions` · `spend_authorizations` · `ledger_entries` · `customers` · `customer_shares` · `tasks` · `schedules` · `approvals` · `drafts` · `tool_calls` · `agent_messages` · `memories` · `experiments` · `agent_config_versions` · `inbound_events` · `notifications` · `audit_log` · `workers` · `kv_store`. See `db/migrations/`.

Money is always integer cents.

## Cost model

24/7 availability does not mean constant inference. With default schedules, each business agent makes one growth cycle per day and one review per week; the CEO one summary per day and one evaluation per week. Each cycle is capped at 8 model turns and each call is reserved before it is made. The global $50/month cap is the hard ceiling for all agent spending. Hosting (~$5–20/month on Railway) is billed separately and is not part of the agent cap.

## Environments

- **Development**: local Postgres (docker compose), `pnpm dev` + `pnpm worker`, mock LLM by default.
- **Test**: `universe_test` database, rebuilt from migrations for every test file; CI runs on GitHub Actions with a Postgres service.
- **Production**: Railway project with `web`, `worker`, Postgres. All agents start **paused** and in **sandbox** mode.
