import { createGoogleAuthorizationUrl, createManualBackup, deleteAllDriveBackups, disconnectDrive, dismissDriveOnboarding, driveBackupOverview, previewBackup, restoreBackup } from "@/lib/server/driveBackup";
import { RequestAuthError, verifyRequestUser } from "@/lib/server/supabaseServer";

export const runtime = "nodejs";

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(error: unknown) {
  if (error instanceof RequestAuthError) return response({ error: error.message }, error.status);
  console.error("Drive backup API error", error);
  return response({ error: error instanceof Error ? error.message : "שגיאה לא ידועה בגיבוי Drive." }, 500);
}

export async function GET(request: Request) {
  try {
    const user = await verifyRequestUser(request);
    return response(await driveBackupOverview(user.id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await verifyRequestUser(request);
    const body = await request.json() as { action?: string; runId?: string; confirmation?: string };
    switch (body.action) {
      case "connect":
        return response({ authorizationUrl: createGoogleAuthorizationUrl(user, new URL(request.url).origin) });
      case "manual_backup":
        return response({ backup: await createManualBackup(user.id) });
      case "preview":
        if (!body.runId) return response({ error: "חסר מזהה גיבוי." }, 400);
        return response({ preview: await previewBackup(user.id, body.runId) });
      case "restore":
        if (!body.runId || body.confirmation !== "RESTORE") return response({ error: "נדרש אישור מפורש לשחזור." }, 400);
        return response({ restore: await restoreBackup(user.id, body.runId) });
      case "dismiss_onboarding":
        await dismissDriveOnboarding(user.id);
        return response({ ok: true });
      case "disconnect":
        if (body.confirmation !== "DISCONNECT") return response({ error: "נדרש אישור מפורש לניתוק." }, 400);
        await disconnectDrive(user.id);
        return response({ ok: true });
      case "delete_backups":
        if (body.confirmation !== "DELETE_BACKUPS") return response({ error: "נדרש אישור מפורש למחיקת גיבויים." }, 400);
        await deleteAllDriveBackups(user.id);
        return response({ ok: true });
      default:
        return response({ error: "פעולת Drive אינה נתמכת." }, 400);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
