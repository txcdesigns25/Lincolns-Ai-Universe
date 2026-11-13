# AI Universe

A business operating system: one **Universe CEO** and seven AI-run businesses (digital product store, website agency, short-form content, SEO, customer support, marketing, automation), each with its own budget, ledger, memory, task queue, permissions and strategy.

**Status:** Phase 1 (platform) and Phase 2 (agent engine) are built and tested. Nothing is deployed yet and no business is earning revenue. See [docs/STATUS.md](docs/STATUS.md) for the honest built-vs-planned list and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works.

## Safety in one paragraph
Every expense is reserved against backend-enforced limits before it happens (7 per-agent limits plus a global $50/month cap). Agents can't change limits or permissions. Anything that reaches the outside world needs a pre-authorization or your approval, and approved actions are executed by deterministic code, not the AI. An emergency stop blocks all spending and external actions at once. Revenue counts only when it comes from a payment provider. Agents start paused and in sandbox mode. The Shopify integration refuses to write to the TXC Designs store.

## Run locally
Requirements: Node 22, pnpm 10, Docker (for Postgres).

```bash
pnpm install
docker compose up -d                 # Postgres on :5432
cp .env.example .env                 # then set OWNER_PASSWORD and SESSION_SECRET
cp .env apps/web/.env.local
set -a; . ./.env; set +a
pnpm db:migrate                      # create tables + seed the 8 agents
pnpm worker                          # terminal 1: background worker
pnpm dev                             # terminal 2: dashboard on http://localhost:3000
```

Without `ANTHROPIC_API_KEY` the agents use a free mock that produces placeholder sandbox output, so you can try everything at no cost.

## Tests
```bash
createdb universe_test               # or use the compose Postgres
pnpm test                            # 50 tests: limits, approvals, queue, crash recovery, isolation, ledger, Telegram...
```

## Deploy 24/7
See [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md).

## Get a Claude API key
1. Go to console.anthropic.com and sign in.
2. **Billing**: add a card and set a monthly spend limit (for example $50).
3. **API Keys → Create Key**, copy it once, and paste it as `ANTHROPIC_API_KEY` on the worker.

## Telegram commands
`/status` · `/activity` · `/updates on|off` · `/ask <agent> <message>` (plain text goes to the CEO) · `/pause <agent|all>` · `/resume <agent|all>` · `/approvals` · `/approve <id>` · `/reject <id>` · `/boost <agent> on|off` · `/stop <reason>`.
Agents: `ceo, store, web, content, seo, support, marketing, automation`.

The bot also messages you on its own: new approval requests (with Approve/Reject buttons for low-risk ones), agents that are blocked on something only you can provide (max 2 per agent per day), errors and limit hits (once per day each), the CEO's daily summary, and a one-line update when an agent finishes work (turn off with `/updates off`). Money and legal approvals, budgets, live mode and releasing the emergency stop are dashboard-only.

## Layout
```
apps/web        Next.js dashboard + lead/webhook endpoints
apps/worker     background worker (scheduler, queue runner, Telegram)
packages/core   engine: budgets, approvals, queue, ledger, memory, tools, Claude client
db/migrations   SQL schema
docs/           architecture, status, deployment
```
