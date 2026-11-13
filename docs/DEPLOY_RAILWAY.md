# Deploy to Railway (24/7)

This runs AI Universe in the cloud so it keeps working with your computer off. You need: a Railway account (Hobby plan), and optionally an Anthropic API key and a Telegram bot token.

## 1. Create the project and database
1. In Railway, click **New Project → Deploy from GitHub repo** and pick `Lincolns-Ai-Universe`. This creates the first service. Rename it to **web** (Settings → Service name).
2. In the project canvas click **+ Create → Database → PostgreSQL**.

## 2. Configure the web service
In **web → Settings**:
- **Config-as-code / Railway config file**: `railway.web.json`
- **Networking → Generate Domain** (this is your dashboard URL)

In **web → Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference variable) |
| `OWNER_PASSWORD` | a long password you'll use to log in |
| `SESSION_SECRET` | any random string, 32+ characters |
| `STRIPE_WEBHOOK_SECRET` | (later, when Stripe is connected) |

## 3. Add the worker service
1. **+ Create → GitHub Repo →** the same repo again. Rename it to **worker**.
2. **worker → Settings → Railway config file**: `railway.worker.json`. Do not generate a domain. Keep **1 replica**.
3. **worker → Variables**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ANTHROPIC_API_KEY` | your key (leave empty to run the free mock) |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_OWNER_ID` | your numeric id from @userinfobot |

The worker runs database migrations and seeds the agents each time it starts (safe to repeat).

## 4. First login
1. Open the web domain, sign in with `OWNER_PASSWORD`.
2. **Settings** should show "Worker" with a recent heartbeat.
3. All agents start **paused** and in **sandbox** mode. Resume the ones you want on **All Agents**.
4. In Telegram, open your bot and send `/status`.

## Costs
- Railway: about $5–20/month for web + worker + Postgres. Set a usage limit in Railway billing. This is separate from the agents' cap.
- Agents: hard-capped at $50/month total (change on **Budgets**).

## Updating
Every push to `main` redeploys both services automatically.

## Backups
Railway Postgres → **Backups** tab: enable scheduled backups.
