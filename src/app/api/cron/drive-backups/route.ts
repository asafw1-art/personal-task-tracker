import { runScheduledBackups } from "@/lib/server/driveBackup";

export const runtime = "nodejs";
export const maxDuration = 120;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

async function run(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json({ ok: true, results: await runScheduledBackups() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Scheduled Drive backups failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Scheduled backup failed" }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
