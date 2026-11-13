# What is built vs planned

Last updated: 2026-11-13. Nothing here is deployed yet, and no business is generating revenue. Agents start paused and in sandbox mode.

## Built and tested (50 automated tests passing)

**Platform (Phase 1)**
- Postgres schema: agents, budgets, ledger, tasks, approvals, memory, experiments, strategy versions, customers, audit log, notifications (3 migrations).
- Dashboard with owner login and all 12 sections: Overview, Universe CEO, All Agents (+ per-agent page), Revenue, Expenses, Budgets, Activity Feed, Customers, Tasks, Memory & Learning, Approvals, Settings.
- Seven business agents + Universe CEO with their own tools, schedules, budgets and ledgers.
- Pause/resume per agent and all at once; run a cycle on demand.

**Agent engine (Phase 2)**
- Claude integration (manual tool loop, adaptive thinking, server-side fallback), mock LLM when no key.
- Durable Postgres queue: priorities, leases, crash recovery, retries with exponential backoff, dead-letter, idempotency keys.
- Scheduler (each slot enqueued once; after downtime, fires once rather than replaying).
- Spending controls: 7 per-agent limits + global $50/month cap, enforced with row locks before every expense; actual AI cost settled into the ledger.
- Three-level approval system; single-use approvals; owner-only decisions; deterministic execution of approved actions.
- Emergency stop.
- Tool-call journal so retries never duplicate side effects.
- Persistent memory with full-text search; observation / hypothesis / verified-result separation enforced.
- Experiments with statistical safeguards; versioned, reversible strategy updates.
- Inter-agent messaging with customer-data isolation.
- Lead capture endpoint and Stripe webhook (signature-verified, idempotent).
- Health checks and notifications (dashboard, Telegram, optional webhook).
- Telegram bot: status, ask any agent, pause/resume, approvals (low-risk only), emergency stop.
- Railway deployment config, Dockerfile, CI workflow.

## Built but not yet verified against real services

- Live Claude calls (no API key yet; the request shape follows the current SDK and is exercised with a mock in tests).
- Shopify product creation via the Admin API, including the TXC Designs guard (guard logic is unit-tested; the live call has not been run).
- Telegram transport (command handling is tested; the Bot API calls run once a bot token is set).
- Stripe webhook against real Stripe events (signature check is tested).
- 24/7 operation on Railway (config written, not deployed).

## Planned next

- **Phase 3, first revenue workflow** (recommended: Digital Product Store on a separate Shopify store). Needs your go-ahead and a store to use.
- Shopify order sync into the ledger (verified revenue, fees, refunds).
- Email sending integration for approved outreach and follow-ups (with unsubscribe handling).
- Web research tool for agents (Claude web search) under the AI budget.
- Landing-page publishing for agents (owned domain).
- Phase 4: bring each remaining business online one at a time.
- Phase 5: richer CEO reviews, budget reallocation proposals based on verified ROI.
