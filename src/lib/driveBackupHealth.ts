export const DRIVE_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class DriveTokenError extends Error {
  constructor(public readonly code: string) {
    const explanation = code === "invalid_grant"
      ? "הרשאת Google אינה תקפה עוד. נדרש חיבור מחדש של חשבון Drive."
      : code === "invalid_client" || code === "unauthorized_client"
        ? "Google דחה את הגדרות החיבור של האפליקציה. נדרשת בדיקת מנהל."
        : code === "temporarily_unavailable" || code === "timeout"
          ? "Google אינו זמין כרגע. ניתן לנסות שוב מאוחר יותר."
          : "חידוש הגישה ל-Google נכשל. נדרשת בדיקת מצב החיבור.";
    super(`[drive_oauth:${code}] ${explanation}`);
    this.name = "DriveTokenError";
  }
}

export function driveTokenError(code: unknown) {
  const allowed = ["invalid_grant", "invalid_client", "unauthorized_client", "temporarily_unavailable", "invalid_request", "invalid_response", "timeout", "network_error"];
  return new DriveTokenError(typeof code === "string" && allowed.includes(code) ? code : "unknown");
}

export function driveConnectionHealth(connection: {
  status: string; lastError: string | null; lastSuccessAt: string | null;
}, now = Date.now()) {
  const reconnectRequired = connection.status === "error" && Boolean(connection.lastError?.includes("[drive_oauth:invalid_grant]"));
  const lastSuccess = connection.lastSuccessAt ? Date.parse(connection.lastSuccessAt) : NaN;
  const backupOverdue = connection.status !== "disconnected" && (!Number.isFinite(lastSuccess) || now - lastSuccess >= DRIVE_BACKUP_MAX_AGE_MS);
  return { reconnectRequired, backupOverdue, healthy: connection.status === "connected" && !backupOverdue };
}
