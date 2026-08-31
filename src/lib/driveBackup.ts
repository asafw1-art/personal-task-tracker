import { supabase } from "@/lib/supabase";

export type DriveBackupConnectionStatus = {
  connected: boolean;
  status: "connected" | "disconnected" | "error";
  googleEmail: string | null;
  timezone: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  shouldPrompt: boolean;
};

export type DriveBackupItem = {
  id: string;
  fileName: string;
  kind: "hourly" | "daily" | "manual" | "pre_restore";
  taskCount: number;
  sizeBytes: number;
  createdAt: string;
};

export type DriveBackupOverview = {
  connection: DriveBackupConnectionStatus;
  backups: DriveBackupItem[];
};

export type DriveBackupPreview = {
  runId: string;
  exportedAt: string;
  kind: DriveBackupItem["kind"];
  taskCount: number;
  taxonomyCount: number;
  shareHistoryCount: number;
  statusCounts: Record<string, number>;
  note: string;
};

async function authorizationHeader() {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("יש להתחבר לפני שימוש בגיבוי Drive.");
  return { Authorization: `Bearer ${data.session.access_token}` };
}

async function requestDrive<T>(method: "GET" | "POST", body?: Record<string, unknown>): Promise<T> {
  const headers = await authorizationHeader();
  const response = await fetch("/api/drive", {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "פעולת Google Drive נכשלה.");
  return result;
}

export function fetchDriveBackupOverview() {
  return requestDrive<DriveBackupOverview>("GET");
}

export async function startDriveConnection() {
  const result = await requestDrive<{ authorizationUrl: string }>("POST", { action: "connect" });
  window.location.assign(result.authorizationUrl);
}

export function createDriveBackup() {
  return requestDrive<{ backup: DriveBackupItem }>("POST", { action: "manual_backup" });
}

export async function fetchDriveBackupPreview(runId: string) {
  const result = await requestDrive<{ preview: DriveBackupPreview }>("POST", { action: "preview", runId });
  return result.preview;
}

export function restoreDriveBackup(runId: string) {
  return requestDrive<{ restore: { restoredAt: string; taskCount: number } }>("POST", { action: "restore", runId, confirmation: "RESTORE" });
}

export function dismissDriveBackupOnboarding() {
  return requestDrive<{ ok: true }>("POST", { action: "dismiss_onboarding" });
}

export function disconnectDriveBackup() {
  return requestDrive<{ ok: true }>("POST", { action: "disconnect", confirmation: "DISCONNECT" });
}

export function deleteDriveBackupFiles() {
  return requestDrive<{ ok: true }>("POST", { action: "delete_backups", confirmation: "DELETE_BACKUPS" });
}
