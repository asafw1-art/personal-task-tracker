import { runScheduledBackups } from "@/lib/server/driveBackup";
import { recordServiceHealth } from "@/lib/server/serviceHealth";

export const runtime = "nodejs";
export const maxDuration = 120;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

async function run(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const results = await runScheduledBackups();
    const failed = results.some((result) => result.hourly !== "ok" || (result.daily && !["ok", "already-created"].includes(result.daily)));
    await recordServiceHealth("scheduler", failed ? "degraded" : "healthy", failed ? "backup_failed" : "ok", "scheduler");
    if (results.length) {
      const reconnectRequired = results.some((result) => [result.hourly, result.daily].some((message) => message?.includes("[drive_oauth:invalid_grant]")));
      await recordServiceHealth("drive", failed ? "error" : "healthy", reconnectRequired ? "drive_reconnect_required" : failed ? "backup_failed" : "ok", "scheduler");
    }
    return Response.json({ ok: !failed, attempted: results.length, failed: results.filter((result) => result.hourly !== "ok" || (result.daily && !["ok", "already-created"].includes(result.daily))).length }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    await recordServiceHealth("scheduler", "error", "backup_failed", "scheduler");
    return Response.json({ error: "Scheduled backup failed" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
