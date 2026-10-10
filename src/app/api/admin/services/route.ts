import { createSupabaseAdmin, verifyRequestUser, RequestAuthError } from "@/lib/server/supabaseServer";
import { providerConfiguration, callApprovedProviders } from "@/lib/server/assistantProviders";
import { recordServiceHealth } from "@/lib/server/serviceHealth";
import type { ServiceHealth, ServiceState } from "@/lib/serviceHealth";
import { driveConnectionHealth } from "@/lib/driveBackupHealth";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function requireAdmin(request: Request) {
  const user = await verifyRequestUser(request);
  if (user.email?.toLowerCase() !== "asafw1@gmail.com") throw new RequestAuthError("אין הרשאת מנהל.", 403);
}

async function overview() {
  const admin = createSupabaseAdmin();
  const now = new Date().toISOString();
  const { error: databaseError } = await admin.from("tasks").select("id", { head: true }).limit(1);
  const persisted = await recordServiceHealth("database", databaseError ? "error" : "healthy", databaseError ? "database_error" : "ok", "probe", now);
  const configs = providerConfiguration();
  for (const config of configs) {
    if (!config.enabled || !config.configured) await recordServiceHealth(config.id, config.enabled ? "unconfigured" : "disabled", config.enabled ? "not_configured" : "disabled_by_operator", "policy", now);
  }
  const { data: rows, error } = await admin.from("service_health").select("service_id,state,reason,source,checked_at,last_success_at,incident_id");
  const services: ServiceHealth[] = configs.map((config) => {
    const row = rows?.find((item) => item.service_id === config.id);
    const stale = row && Date.now() - Date.parse(row.checked_at) > 24 * 60 * 60 * 1000;
    const inactiveRecord = row && ["disabled", "unconfigured"].includes(row.state);
    const state: ServiceState = !config.enabled ? "disabled" : !config.configured ? "unconfigured"
      : !row || stale || inactiveRecord ? "unknown" : row.state;
    const reason = !config.enabled ? "disabled_by_operator" : !config.configured ? "not_configured"
      : stale ? "stale" : !row || inactiveRecord ? "not_checked" : row.reason;
    return { ...config, state, reason, checkedAt: row?.checked_at ?? null, lastSuccessAt: row?.last_success_at ?? null,
      incidentId: state === "healthy" ? null : row?.incident_id || `${config.id}:${reason}:${row?.checked_at || "initial"}`, source: row?.source || "policy" };
  });
  services.push({ id: "database", label: "מסד הנתונים", configured: true, enabled: true,
    state: databaseError ? "error" : "healthy", reason: databaseError ? "database_error" : "ok", checkedAt: now,
    lastSuccessAt: databaseError ? rows?.find((row) => row.service_id === "database")?.last_success_at ?? null : now,
    incidentId: databaseError ? rows?.find((row) => row.service_id === "database")?.incident_id || "database:error" : null, source: "probe" });
  const drive = await admin.from("drive_backup_connections").select("status,last_success_at,last_error").neq("status", "disconnected").limit(1001);
  const active = drive.data ?? [];
  const staleBackup = active.some((row) => !row.last_success_at || Date.now() - Date.parse(row.last_success_at) > 86400000);
  const reconnectRequired = active.some((row) => driveConnectionHealth({ status: row.status, lastError: row.last_error, lastSuccessAt: row.last_success_at }).reconnectRequired);
  const driveReason = drive.error || active.length > 1000 ? "backup_not_checked" : reconnectRequired ? "drive_reconnect_required" : active.some((row) => row.status === "error") ? "backup_failed"
    : staleBackup ? "backup_stale" : !active.length ? "no_connections" : "ok";
  const successes = active.map((row) => row.last_success_at).filter(Boolean).sort();
  const driveState: ServiceState = driveReason === "ok" ? "healthy" : driveReason === "no_connections" ? "unconfigured" : driveReason === "backup_not_checked" ? "unknown" : "error";
  const drivePersisted = await recordServiceHealth("drive", driveState, driveReason, "probe", now);
  const driveIncident = await admin.from("service_health").select("incident_id").eq("service_id", "drive").maybeSingle();
  services.push({ id: "drive", label: "גיבוי Drive", configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET), enabled: true,
    state: driveState,
    reason: driveReason, checkedAt: now, lastSuccessAt: successes[0] ?? null,
    incidentId: ["ok", "no_connections"].includes(driveReason) ? null : driveIncident.data?.incident_id || `drive:${driveReason}`, source: "backup_records" });
  const scheduler = rows?.find((row) => row.service_id === "scheduler");
  const freshScheduler = scheduler && Date.now() - Date.parse(scheduler.checked_at) < 86400000;
  const schedulerConfigured = Boolean(process.env.CRON_SECRET);
  services.push({ id: "scheduler", label: "תזמון גיבויים", configured: schedulerConfigured, enabled: true,
    state: !schedulerConfigured ? "unconfigured" : freshScheduler ? scheduler.state : "unknown", reason: !schedulerConfigured ? "not_configured" : freshScheduler ? scheduler.reason : scheduler ? "stale" : "not_checked",
    checkedAt: scheduler?.checked_at ?? null, lastSuccessAt: scheduler?.last_success_at ?? null,
    incidentId: freshScheduler && scheduler.state === "healthy" ? null : scheduler?.incident_id || `scheduler:${scheduler?.checked_at || "initial"}`, source: "scheduler" });
  return { services, generatedAt: now, monitoringAvailable: persisted && drivePersisted && !error && !driveIncident.error };
}

export async function GET(request: Request) {
  try { await requireAdmin(request); return json(await overview()); }
  catch (error) { return json({ error: error instanceof RequestAuthError ? error.message : "לא ניתן לקרוא את מצב השירותים." }, error instanceof RequestAuthError ? error.status : 503); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const raw = await request.text();
    if (raw.length > 200) return json({ error: "בקשה לא תקינה." }, 400);
    const { service } = JSON.parse(raw);
    const config = providerConfiguration().find((item) => item.id === service);
    if (!config?.enabled || !config.configured) return json({ error: "הספק מושבת או אינו מוגדר." }, 409);
    const { data, error } = await createSupabaseAdmin().from("service_health").select("checked_at").eq("service_id", service).maybeSingle();
    if (error) return json({ error: "נדרש ניטור תקין לפני בדיקת ספק." }, 503);
    if (data && Date.now() - Date.parse(data.checked_at) < 60000) return json({ error: "ניתן לבדוק ספק לכל היותר פעם בדקה." }, 429);
    await callApprovedProviders('Return exactly {"reply":"ok"}.', { test: "synthetic_health_check" }, [config], (content) => {
      try { return JSON.parse(content).reply === "ok"; } catch { return false; }
    }, true);
    return json(await overview());
  } catch (error) { return json({ error: error instanceof RequestAuthError ? error.message : "בדיקת השירות נכשלה." }, error instanceof RequestAuthError ? error.status : 503); }
}
