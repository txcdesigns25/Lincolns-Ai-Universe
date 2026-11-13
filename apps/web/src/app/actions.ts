"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  decideApproval, engageEmergencyStop, releaseEmergencyStop, setBudget, setGlobalMonthlyLimit, setGlobalDailyLimit, setPerAgentLimitsEnabled, grantPermission,
  activateConfigVersion, rejectConfigVersion, enqueue, audit, ACTIONS,
} from "@universe/core";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";
import { timingSafeEqual } from "node:crypto";

const cents = (v: FormDataEntryValue | null) => Math.round(Number(v ?? 0) * 100);

export async function login(_: unknown, form: FormData) {
  const expected = process.env.OWNER_PASSWORD;
  const given = String(form.get("password") ?? "");
  if (!expected || expected.length < 8) return { error: "OWNER_PASSWORD is not configured on the server (min 8 chars)." };
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await new Promise((r) => setTimeout(r, 800));
    return { error: "Wrong password." };
  }
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: SESSION_MAX_AGE, path: "/" });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function setAgentStatus(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("agent_id"));
  const status = String(form.get("status"));
  if (!["active", "paused"].includes(status)) throw new Error("bad status");
  await db().query(`UPDATE agents SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  await audit(db(), { actor: by, agentId: id, action: `agent.${status === "active" ? "resume" : "pause"}`, outcome: "info" });
  revalidatePath("/", "layout");
}

export async function setAllAgents(form: FormData) {
  const by = await requireOwner();
  const status = String(form.get("status"));
  if (!["active", "paused"].includes(status)) throw new Error("bad status");
  await db().query(`UPDATE agents SET status = $1, updated_at = now() WHERE status IN ('active','paused')`, [status]);
  await audit(db(), { actor: by, action: `agents.${status}_all`, outcome: "info" });
  revalidatePath("/", "layout");
}

export async function setLiveMode(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("agent_id"));
  const live = form.get("live") === "true";
  if (live && form.get("confirm") !== "LIVE") throw new Error("Type LIVE to confirm");
  await db().query(`UPDATE agents SET live_mode = $2, updated_at = now() WHERE id = $1`, [id, live]);
  await audit(db(), { actor: by, agentId: id, action: `agent.live_mode.${live ? "on" : "off"}`, outcome: "info" });
  revalidatePath("/", "layout");
}

export async function runAgentNow(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("agent_id"));
  const type = id === "ceo" ? "daily_summary" : "growth_cycle";
  await enqueue(db(), { agentId: id, type, title: id === "ceo" ? "Daily performance summary (manual)" : "Autonomous growth cycle (manual)",
    priority: 3, createdBy: by, idempotencyKey: `manual:${id}:${Math.floor(Date.now() / 60000)}` });
  revalidatePath("/", "layout");
}

export async function updateBudget(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("agent_id"));
  await setBudget(db(), id, {
    starting_budget: cents(form.get("starting_budget")), daily_limit: cents(form.get("daily_limit")),
    weekly_limit: cents(form.get("weekly_limit")), monthly_limit: cents(form.get("monthly_limit")),
    per_transaction_limit: cents(form.get("per_transaction_limit")), ai_monthly_limit: cents(form.get("ai_monthly_limit")),
    ads_monthly_limit: cents(form.get("ads_monthly_limit")),
  }, by);
  revalidatePath("/", "layout");
}

export async function updateGlobalLimit(form: FormData) {
  const by = await requireOwner();
  await setGlobalMonthlyLimit(db(), cents(form.get("global_monthly_limit")), by);
  const daily = form.get("global_daily_limit");
  if (daily != null) await setGlobalDailyLimit(db(), String(daily).trim() === "" ? null : cents(daily), by);
  revalidatePath("/", "layout");
}

export async function togglePerAgentLimits(form: FormData) {
  const by = await requireOwner();
  await setPerAgentLimitsEnabled(db(), form.get("enabled") === "true", by);
  revalidatePath("/", "layout");
}

/** Boost: this agent is on an important project, so it uses the stronger model (still within all caps). */
export async function setBoost(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("agent_id"));
  const boost = form.get("boost") === "true";
  await db().query(`UPDATE agents SET boost = $2, updated_at = now() WHERE id = $1`, [id, boost]);
  await audit(db(), { actor: by, agentId: id, action: `agent.boost.${boost ? "on" : "off"}`, outcome: "info" });
  revalidatePath("/", "layout");
}

export async function decide(form: FormData) {
  const by = await requireOwner();
  const decision = String(form.get("decision")) as "approved" | "rejected";
  await decideApproval(db(), String(form.get("approval_id")), decision, by, String(form.get("note") ?? "") || undefined);
  revalidatePath("/", "layout");
}

export async function emergencyStop(form: FormData) {
  const by = await requireOwner();
  await engageEmergencyStop(db(), by, String(form.get("reason") || "Engaged from dashboard"));
  revalidatePath("/", "layout");
}

export async function emergencyRelease() {
  const by = await requireOwner();
  await releaseEmergencyStop(db(), by);
  revalidatePath("/", "layout");
}

export async function togglePermission(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("agent_id")), action = String(form.get("action"));
  if (!ACTIONS[action] || ACTIONS[action].level !== 2) throw new Error("Only Level 2 actions can be preauthorized");
  if (form.get("grant") === "true") await grantPermission(db(), id, action, by);
  else {
    await db().query(`DELETE FROM agent_permissions WHERE agent_id = $1 AND action = $2`, [id, action]);
    await audit(db(), { actor: by, agentId: id, action: "permission.revoke", outcome: "info", details: { action } });
  }
  revalidatePath("/", "layout");
}

export async function decideVersion(form: FormData) {
  const by = await requireOwner();
  const id = String(form.get("version_id"));
  if (form.get("decision") === "reject") await rejectConfigVersion(db(), id, by);
  else await activateConfigVersion(db(), id, by);
  revalidatePath("/", "layout");
}

export async function ackNotification(form: FormData) {
  await requireOwner();
  await db().query(`UPDATE notifications SET acknowledged = TRUE WHERE id = $1`, [String(form.get("id"))]);
  revalidatePath("/", "layout");
}

export async function retryTask(form: FormData) {
  const by = await requireOwner();
  await db().query(`UPDATE tasks SET status = 'queued', attempts = 0, run_at = now(), last_error = NULL WHERE id = $1 AND status IN ('dead','failed')`, [String(form.get("task_id"))]);
  await audit(db(), { actor: by, action: "task.retry", outcome: "info", details: { id: form.get("task_id") } });
  revalidatePath("/", "layout");
}
