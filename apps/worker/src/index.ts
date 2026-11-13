/**
 * AI Universe background worker.
 *
 * One long-running process that:
 *  - turns due schedules into tasks (scheduler)
 *  - turns inbound events (leads, payment webhooks) into tasks / ledger rows
 *  - claims tasks from the Postgres queue with a lease and runs them
 *  - recovers tasks from crashed workers and records heartbeats
 *
 * Runs locally while your computer is on. It is stateless, so the same
 * process can later run on any always-on host without code changes.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  tiersFromEnv, releaseStaleReservations, getDb, closeDb, createLlmFromEnv, claimNext, completeTask, failTask, parkForApproval, recoverExpiredLeases,
  extendLease, runTask, tickScheduler, processInboundEvents, PolicyDenied, RetryableError, AwaitingApproval, notify, audit,
  telegramConfigured, pollTelegramOnce, telegramSend, initTelegram,
} from "@universe/core";

const db = getDb();
const llm = createLlmFromEnv();
const workerId = `worker-${hostname()}-${randomUUID().slice(0, 8)}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
const LEASE_SECONDS = 300;
let stopping = false;

const log = (msg: string, extra?: unknown) =>
  console.log(`${new Date().toISOString()} [${workerId}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

async function housekeeping() {
  await db.query(
    `INSERT INTO workers (id, hostname) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET last_heartbeat = now()`, [workerId, hostname()]);
  const released = await releaseStaleReservations(db);
  if (released) log(`released ${released} stale AI reservation(s)`);
  const recovered = await recoverExpiredLeases(db);
  if (recovered) log(`recovered ${recovered} task(s) from expired leases`);
  const scheduled = await tickScheduler(db);
  if (scheduled) log(`scheduled ${scheduled} task(s)`);
  const events = await processInboundEvents(db);
  if (events) log(`processed ${events} inbound event(s)`);
}

async function runOne(): Promise<boolean> {
  const task = await claimNext(db, workerId, LEASE_SECONDS);
  if (!task) return false;
  log(`run ${task.type} for ${task.agent_id}`, { id: task.id, attempt: task.attempts });
  const lease = setInterval(() => extendLease(db, task.id, workerId, LEASE_SECONDS).catch(() => {}), (LEASE_SECONDS / 3) * 1000);
  try {
    const result = await runTask({ db, llm, workerId }, task);
    await completeTask(db, task.id, workerId, result);
    const chat = (task.payload as any)?.reply_to_telegram_chat;
    if (chat) await telegramSend(chat, `${task.agent_id}: ${(result as any)?.summary || "Done."}`.slice(0, 4000)).catch(() => {});
    await db.query(`UPDATE workers SET tasks_done = tasks_done + 1 WHERE id = $1`, [workerId]);
    log(`done ${task.id}`);
  } catch (err: any) {
    if (err instanceof AwaitingApproval) {
      await parkForApproval(db, task.id, workerId, err.approvalId);
      log(`parked ${task.id} awaiting approval ${err.approvalId}`);
    } else if (err instanceof PolicyDenied) {
      // Blocked by a control (paused, emergency stop, limit). Not retried.
      await failTask(db, task.id, workerId, `${err.code}: ${err.message}`, { retryable: false });
      log(`blocked ${task.id}: ${err.code}`);
      if (["daily_limit", "monthly_limit", "global_monthly_limit", "global_daily_limit", "starting_budget", "ai_monthly_limit"].includes(err.code)) {
        await notify(db, { severity: "warning", agentId: task.agent_id, title: `${task.agent_id} hit a spending limit (${err.code})`,
          body: err.message, dedupeKey: `limit:${task.agent_id}:${err.code}:${new Date().toISOString().slice(0, 10)}` });
      }
    } else {
      // Unknown errors are retried with backoff (safe: tool calls are journaled
      // and spend is idempotent), then dead-lettered with a notification.
      const retryable = err instanceof RetryableError || !(err instanceof TypeError || err instanceof SyntaxError);
      await failTask(db, task.id, workerId, String(err?.stack ?? err), { retryable, retryAfterMs: err?.retryAfterMs });
      log(`error ${task.id}: ${err?.message ?? err}`);
      const t = (await db.query(`SELECT status FROM tasks WHERE id = $1`, [task.id])).rows[0];
      if (t?.status === "dead" || t?.status === "failed") {
        await notify(db, { severity: "warning", agentId: task.agent_id, title: `Task failed: ${task.title}`,
          body: String(err?.message ?? err).slice(0, 500), dedupeKey: `taskfail:${task.id}` });
      }
    }
  } finally {
    clearInterval(lease);
  }
  return true;
}

async function loop(slot: number) {
  while (!stopping) {
    try {
      const didWork = await runOne();
      if (!didWork) await sleep(POLL_MS + slot * 250);
    } catch (err: any) {
      log(`loop error: ${err?.message ?? err}`);
      await sleep(POLL_MS * 2);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log(`starting (llm=${llm.provider}:${llm.model}, important=${tiersFromEnv().important.model}, concurrency=${CONCURRENCY})`);
  if (llm.provider === "mock") log("No ANTHROPIC_API_KEY set: agents use the free mock LLM (sandbox output only).");
  // Publish what this worker can do, so the dashboard (a separate service) can show it.
  await db.query(`INSERT INTO kv_store (key, value) VALUES ('worker_config', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify({ llm: llm.provider, model: llm.model, modelImportant: llm.provider === "mock" ? "mock" : tiersFromEnv().important.model, telegram: telegramConfigured(), shopify: !!(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN), notifyWebhook: !!process.env.NOTIFY_WEBHOOK_URL })]);
  await audit(db, { actor: workerId, action: "worker.start", outcome: "info", details: { llm: llm.provider, model: llm.model } });
  const hk = setInterval(() => housekeeping().catch((e) => log(`housekeeping error: ${e.message}`)), 30_000);
  await housekeeping();
  const loops = Array.from({ length: CONCURRENCY }, (_, i) => loop(i));
  if (!telegramConfigured()) log("Telegram disabled: TELEGRAM_BOT_TOKEN and/or TELEGRAM_OWNER_ID not set on this service");
  else {
    loops.push((async () => {
      try { log(`Telegram bot @${await initTelegram()} enabled (owner-only)`); }
      catch (e: any) { log(`Telegram NOT started: ${e.message}`); return; }
      while (!stopping) {
        try { await pollTelegramOnce(db, 25); }
        catch (e: any) { log(`telegram error: ${e.message}`); await sleep(10_000); }
      }
    })());
  }
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received, finishing current tasks...`);
    clearInterval(hk);
    await Promise.race([Promise.all(loops), sleep(20_000)]);
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => { console.error(e); process.exit(1); });
