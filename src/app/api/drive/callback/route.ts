import { createBackupForConnection, decodeOAuthState, exchangeGoogleCode, googleAccountEmail, saveGoogleConnection } from "@/lib/server/driveBackup";

export const runtime = "nodejs";

function appRedirect(request: Request, state: string, message?: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin;
  const url = new URL(appUrl);
  url.searchParams.set("drive", state);
  if (message) url.searchParams.set("driveMessage", message.slice(0, 180));
  return Response.redirect(url, 303);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  if (oauthError) return appRedirect(request, "cancelled", "חיבור Google Drive בוטל.");
  if (!code || !state) return appRedirect(request, "error", "חסרים פרטי החיבור מ-Google.");
  try {
    const userId = decodeOAuthState(state);
    const tokens = await exchangeGoogleCode(code, new URL(request.url).origin);
    if (!tokens.refresh_token) throw new Error("Google לא החזיר הרשאה לשימוש כשהאפליקציה סגורה. יש לנסות לחבר שוב.");
    const email = await googleAccountEmail(tokens.access_token!);
    const connection = await saveGoogleConnection(userId, email, tokens.refresh_token);
    try {
      await createBackupForConnection(connection, "manual");
      return appRedirect(request, "connected", "החיבור הושלם ונוצר גיבוי ראשון.");
    } catch (backupError) {
      return appRedirect(request, "connected", `החיבור הושלם, אך הגיבוי הראשון נכשל: ${backupError instanceof Error ? backupError.message : "שגיאה לא ידועה"}`);
    }
  } catch (error) {
    console.error("Google Drive OAuth callback failed", error);
    return appRedirect(request, "error", error instanceof Error ? error.message : "חיבור Google Drive נכשל.");
  }
}
