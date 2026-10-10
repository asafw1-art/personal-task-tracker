export type ServiceId = "gemini" | "gateway" | "database" | "drive" | "scheduler";
export type ServiceState = "healthy" | "degraded" | "error" | "disabled" | "unconfigured" | "unknown";
export type ServiceHealth = {
  id: ServiceId; label: string; configured: boolean; enabled: boolean;
  state: ServiceState; reason: string; checkedAt: string | null; lastSuccessAt: string | null;
  incidentId: string | null; source: string; model?: string; privacyVerified?: boolean;
};
export type ServiceHealthOverview = { services: ServiceHealth[]; generatedAt: string; monitoringAvailable: boolean };
export const serviceStateLabels: Record<ServiceState, string> = {
  healthy: "תקין", degraded: "מוגבל", error: "תקלה", disabled: "מושבת", unconfigured: "לא מוגדר", unknown: "לא נבדק",
};
export const serviceReasonLabels: Record<string, string> = {
  ok: "בדיקה הצליחה", disabled_by_operator: "הספק הושבת במפורש בידי המפעיל",
  not_configured: "חסרה הגדרת שירות", not_checked: "טרם נרשמה בדיקת תקינות",
  stale: "הבדיקה האחרונה אינה עדכנית", rate_limited: "מכסת הספק הוגבלה",
  unauthorized: "פרטי הגישה נדחו", timeout: "הספק לא ענה בזמן", provider_error: "שגיאה אצל הספק",
  invalid_response: "התקבלה תשובה שאינה תקינה", network_error: "החיבור לספק נכשל",
  overloaded: "הספק עמוס זמנית", credits_exhausted: "יתרת השימוש אצל הספק אינה מספיקה",
  access_denied: "הספק חסם את הגישה; נדרשת בדיקת הרשאות או תנאי החשבון",
  model_unavailable: "המודל המבוקש אינו זמין", invalid_request: "הספק דחה את מבנה הבקשה",
  truncated_response: "תשובת הספק נקטעה לפני שהושלמה",
  database_error: "בדיקת מסד הנתונים נכשלה", monitoring_unavailable: "רישום הניטור אינו זמין",
  backup_failed: "קיים גיבוי שנכשל", backup_stale: "קיים חשבון ללא גיבוי מוצלח ביממה האחרונה",
  drive_reconnect_required: "הרשאת Google אינה תקפה; נדרש חיבור מחדש של חשבון Drive",
  backup_not_checked: "לא אומתה זמינות הגיבוי מול ספק האחסון", no_connections: "אין חיבורי גיבוי פעילים",
};
