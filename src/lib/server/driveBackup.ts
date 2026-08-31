import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createSupabaseAdmin } from "@/lib/server/supabaseServer";

export type BackupKind = "hourly" | "daily" | "manual" | "pre_restore";

type DriveConnection = {
  user_id: string;
  google_email: string | null;
  folder_id: string | null;
  encrypted_refresh_token: string | null;
  timezone: string;
  status: "connected" | "disconnected" | "error";
  onboarding_prompt_count: number;
  remind_after: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  connected_at: string | null;
};

type BackupRun = {
  id: string;
  file_id: string;
  file_name: string;
  backup_kind: BackupKind;
  local_date: string | null;
  task_count: number;
  size_bytes: number | string;
  checksum: string;
  created_at: string;
  deleted_at: string | null;
};

type SnapshotData = {
  tasks: Record<string, unknown>[];
  taxonomy: Record<string, unknown>[];
  settings: Record<string, unknown> | null;
  shareHistory: Record<string, unknown>[];
};

type DriveSnapshot = {
  format: "personal-task-tracker-backup";
  version: 2;
  exportedAt: string;
  kind: BackupKind;
  ownerUserId: string;
  data: SnapshotData;
  integrity: { algorithm: "SHA-256"; checksum: string; signature: string };
};

const DRIVE_SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const BACKUP_FOLDER_NAME = "גיבויי המשימות שלי";
const RETENTION: Record<BackupKind, number> = { hourly: 5, daily: 5, manual: 5, pre_restore: 5 };

function env(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
}

function encryptionKey() {
  return createHash("sha256").update(env("DRIVE_TOKEN_ENCRYPTION_KEY")).digest();
}

function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptToken(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Stored Drive token is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

function encodeState(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", encryptionKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function decodeOAuthState(state: string) {
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("OAuth state is invalid");
  const expected = createHmac("sha256", encryptionKey()).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("OAuth state signature is invalid");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { userId?: string; exp?: number };
  if (!payload.userId || !payload.exp || payload.exp < Date.now()) throw new Error("OAuth state expired");
  return payload.userId;
}

function redirectUri(origin?: string) {
  return process.env.GOOGLE_DRIVE_REDIRECT_URI?.trim() || `${origin || env("NEXT_PUBLIC_APP_URL")}/api/drive/callback`;
}

export function createGoogleAuthorizationUrl(user: User, origin: string) {
  const query = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    login_hint: user.email ?? "",
    state: encodeState({ userId: user.id, exp: Date.now() + 10 * 60_000, nonce: randomBytes(12).toString("hex") }),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
}

async function googleTokenRequest(params: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    cache: "no-store",
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error_description || "Google token request failed");
  return body;
}

export async function exchangeGoogleCode(code: string, origin: string) {
  return googleTokenRequest(new URLSearchParams({
    code,
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  }));
}

async function refreshAccessToken(encryptedRefreshToken: string) {
  const tokens = await googleTokenRequest(new URLSearchParams({
    refresh_token: decryptToken(encryptedRefreshToken),
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    grant_type: "refresh_token",
  }));
  return tokens.access_token!;
}

async function googleJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason;
    throw new Error([reason, body.error?.message, `Google Drive request failed (${response.status})`].filter(Boolean).join(": "));
  }
  return body;
}

export async function googleAccountEmail(accessToken: string) {
  const profile = await googleJson<{ email?: string }>("https://openidconnect.googleapis.com/v1/userinfo", accessToken);
  return profile.email?.trim().toLowerCase() || null;
}

async function folderExists(folderId: string, accessToken: string) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`, {
    headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store",
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Google Drive folder check failed (${response.status})`);
  const body = await response.json() as { trashed?: boolean };
  return !body.trashed;
}

async function ensureFolder(connection: DriveConnection, accessToken: string, admin: SupabaseClient) {
  if (connection.folder_id && await folderExists(connection.folder_id, accessToken)) return connection.folder_id;
  const folder = await googleJson<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", accessToken, {
    method: "POST",
    body: JSON.stringify({
      name: BACKUP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      appProperties: { application: "personal-task-tracker", purpose: "backup-folder" },
    }),
  });
  await admin.from("drive_backup_connections").update({ folder_id: folder.id, updated_at: new Date().toISOString() }).eq("user_id", connection.user_id);
  return folder.id;
}

function checksum(data: unknown) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function snapshotSignature(userId: string, exportedAt: string, kind: BackupKind, dataChecksum: string) {
  return createHmac("sha256", encryptionKey()).update(`${userId}\n${exportedAt}\n${kind}\n${dataChecksum}`).digest("hex");
}

function validateSnapshot(snapshot: DriveSnapshot, expectedUserId: string) {
  const supportedKinds: BackupKind[] = ["hourly", "daily", "manual", "pre_restore"];
  const validData = snapshot.data
    && Array.isArray(snapshot.data.tasks)
    && Array.isArray(snapshot.data.taxonomy)
    && Array.isArray(snapshot.data.shareHistory)
    && (snapshot.data.settings === null || (typeof snapshot.data.settings === "object" && !Array.isArray(snapshot.data.settings)));
  if (snapshot.format !== "personal-task-tracker-backup"
      || snapshot.version !== 2
      || snapshot.ownerUserId !== expectedUserId
      || !supportedKinds.includes(snapshot.kind)
      || !snapshot.exportedAt
      || Number.isNaN(Date.parse(snapshot.exportedAt))
      || !validData) {
    throw new Error("קובץ הגיבוי אינו שייך לחשבון הזה או שאינו בפורמט נתמך.");
  }
}

function signaturesMatch(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function buildSnapshot(admin: SupabaseClient, userId: string, kind: BackupKind): Promise<DriveSnapshot> {
  const [tasksResult, taxonomyResult, settingsResult, sharesResult] = await Promise.all([
    admin.from("tasks").select("*").eq("user_id", userId).order("prefix").order("task_number"),
    admin.from("task_taxonomy_items").select("*").eq("user_id", userId).order("item_type").order("name"),
    admin.from("user_settings").select("*").eq("user_id", userId).maybeSingle(),
    admin.from("task_shares").select("*").eq("owner_user_id", userId).order("created_at"),
  ]);
  for (const result of [tasksResult, taxonomyResult, settingsResult, sharesResult]) {
    if (result.error) throw result.error;
  }
  const data: SnapshotData = {
    tasks: (tasksResult.data ?? []) as Record<string, unknown>[],
    taxonomy: (taxonomyResult.data ?? []) as Record<string, unknown>[],
    settings: (settingsResult.data ?? null) as Record<string, unknown> | null,
    shareHistory: (sharesResult.data ?? []) as Record<string, unknown>[],
  };
  const dataChecksum = checksum(data);
  const exportedAt = new Date().toISOString();
  return {
    format: "personal-task-tracker-backup",
    version: 2,
    exportedAt,
    kind,
    ownerUserId: userId,
    data,
    integrity: { algorithm: "SHA-256", checksum: dataChecksum, signature: snapshotSignature(userId, exportedAt, kind, dataChecksum) },
  };
}

function localDateParts(timezone: string, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { date: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) };
  } catch {
    return localDateParts("Asia/Jerusalem", date);
  }
}

function backupFileName(kind: BackupKind, exportedAt: string) {
  return `task-backup-${kind}-${exportedAt.replace(/[:.]/g, "-")}.json`;
}

async function uploadSnapshot(accessToken: string, folderId: string, snapshot: DriveSnapshot) {
  const content = JSON.stringify(snapshot, null, 2);
  const fileName = backupFileName(snapshot.kind, snapshot.exportedAt);
  const boundary = `backup_${randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    mimeType: "application/json",
    appProperties: { application: "personal-task-tracker", kind: snapshot.kind, version: String(snapshot.version) },
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n`),
    Buffer.from(`--${boundary}--`),
  ]);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const result = await response.json().catch(() => ({})) as { id?: string; name?: string; size?: string; error?: { message?: string; errors?: { reason?: string }[] } };
  if (!response.ok || !result.id) {
    const reason = result.error?.errors?.[0]?.reason;
    throw new Error([reason, result.error?.message, `Google Drive upload failed (${response.status})`].filter(Boolean).join(": "));
  }
  return { id: result.id, name: result.name || fileName, size: Number(result.size || Buffer.byteLength(content)) };
}

async function deleteDriveFile(accessToken: string, fileId: string) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store",
  });
  if (!response.ok && response.status !== 404) throw new Error(`Google Drive delete failed (${response.status})`);
}

async function cleanupBackups(admin: SupabaseClient, connection: DriveConnection, accessToken: string, kind: BackupKind, keep = RETENTION[kind]) {
  const { data, error } = await admin.from("drive_backup_runs").select("id,file_id").eq("user_id", connection.user_id)
    .eq("backup_kind", kind).is("deleted_at", null).order("created_at", { ascending: false });
  if (error) throw error;
  for (const run of (data ?? []).slice(keep)) {
    await deleteDriveFile(accessToken, run.file_id);
    await admin.from("drive_backup_runs").update({ deleted_at: new Date().toISOString() }).eq("id", run.id);
  }
}

function isQuotaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /storageQuotaExceeded|quota|storage/i.test(message);
}

export async function createBackupForConnection(connection: DriveConnection, kind: BackupKind) {
  if (!connection.encrypted_refresh_token || connection.status === "disconnected") throw new Error("Drive is not connected");
  const admin = createSupabaseAdmin();
  const attemptedAt = new Date().toISOString();
  await admin.from("drive_backup_connections").update({ last_attempt_at: attemptedAt, updated_at: attemptedAt }).eq("user_id", connection.user_id);
  try {
    const accessToken = await refreshAccessToken(connection.encrypted_refresh_token);
    const folderId = await ensureFolder(connection, accessToken, admin);
    const snapshot = await buildSnapshot(admin, connection.user_id, kind);
    let uploaded;
    try {
      uploaded = await uploadSnapshot(accessToken, folderId, snapshot);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      await cleanupBackups(admin, connection, accessToken, kind, Math.max(0, RETENTION[kind] - 1));
      uploaded = await uploadSnapshot(accessToken, folderId, snapshot);
    }
    const localDate = localDateParts(connection.timezone, new Date(snapshot.exportedAt)).date;
    const { data: run, error: runError } = await admin.from("drive_backup_runs").insert({
      user_id: connection.user_id,
      file_id: uploaded.id,
      file_name: uploaded.name,
      backup_kind: kind,
      local_date: kind === "daily" ? localDate : null,
      task_count: snapshot.data.tasks.length,
      size_bytes: uploaded.size,
      checksum: snapshot.integrity.checksum,
    }).select("*").single();
    if (runError) {
      await deleteDriveFile(accessToken, uploaded.id).catch(() => undefined);
      throw runError;
    }
    await cleanupBackups(admin, connection, accessToken, kind);
    await admin.from("drive_backup_connections").update({
      status: "connected", last_success_at: snapshot.exportedAt, last_error: null, updated_at: snapshot.exportedAt,
    }).eq("user_id", connection.user_id);
    return run as BackupRun;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Drive backup failed";
    await admin.from("drive_backup_connections").update({ status: "error", last_error: message.slice(0, 500), updated_at: attemptedAt }).eq("user_id", connection.user_id);
    throw error;
  }
}

export async function saveGoogleConnection(userId: string, googleEmail: string | null, refreshToken: string) {
  const admin = createSupabaseAdmin();
  const { data: existing } = await admin.from("drive_backup_connections").select("google_email,folder_id").eq("user_id", userId).maybeSingle();
  const sameAccount = existing?.google_email && googleEmail && existing.google_email === googleEmail;
  const { data, error } = await admin.from("drive_backup_connections").upsert({
    user_id: userId,
    google_email: googleEmail,
    folder_id: sameAccount ? existing.folder_id : null,
    encrypted_refresh_token: encryptToken(refreshToken),
    status: "connected",
    connected_at: new Date().toISOString(),
    disconnected_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" }).select("*").single();
  if (error) throw error;
  return data as DriveConnection;
}

async function getConnection(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.from("drive_backup_connections").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as DriveConnection | null;
}

export async function driveBackupOverview(userId: string) {
  const admin = createSupabaseAdmin();
  const [connection, runsResult] = await Promise.all([
    getConnection(admin, userId),
    admin.from("drive_backup_runs").select("id,file_id,file_name,backup_kind,local_date,task_count,size_bytes,checksum,created_at,deleted_at")
      .eq("user_id", userId).is("deleted_at", null).order("created_at", { ascending: false }).limit(30),
  ]);
  if (runsResult.error) throw runsResult.error;
  const now = Date.now();
  const shouldPrompt = !connection?.encrypted_refresh_token && (connection?.onboarding_prompt_count ?? 0) < 2
    && (!connection?.remind_after || new Date(connection.remind_after).getTime() <= now);
  return {
    connection: {
      connected: Boolean(connection?.encrypted_refresh_token && connection.status !== "disconnected"),
      status: connection?.status ?? "disconnected",
      googleEmail: connection?.google_email ?? null,
      timezone: connection?.timezone ?? "Asia/Jerusalem",
      lastAttemptAt: connection?.last_attempt_at ?? null,
      lastSuccessAt: connection?.last_success_at ?? null,
      lastError: connection?.last_error ?? null,
      shouldPrompt,
    },
    backups: ((runsResult.data ?? []) as BackupRun[]).map((run) => ({
      id: run.id,
      fileName: run.file_name,
      kind: run.backup_kind,
      taskCount: run.task_count,
      sizeBytes: Number(run.size_bytes),
      createdAt: run.created_at,
    })),
  };
}

export async function createManualBackup(userId: string, kind: BackupKind = "manual") {
  const admin = createSupabaseAdmin();
  const connection = await getConnection(admin, userId);
  if (!connection) throw new Error("Google Drive is not connected");
  return createBackupForConnection(connection, kind);
}

async function downloadSnapshot(connection: DriveConnection, runId: string) {
  if (!connection.encrypted_refresh_token) throw new Error("Google Drive is not connected");
  const admin = createSupabaseAdmin();
  const { data: run, error } = await admin.from("drive_backup_runs").select("*").eq("id", runId).eq("user_id", connection.user_id).is("deleted_at", null).single();
  if (error) throw error;
  const accessToken = await refreshAccessToken(connection.encrypted_refresh_token);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(run.file_id)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store",
  });
  if (!response.ok) throw new Error(`Google Drive download failed (${response.status})`);
  const snapshot = await response.json() as DriveSnapshot;
  validateSnapshot(snapshot, connection.user_id);
  const actualChecksum = checksum(snapshot.data);
  const expectedSignature = snapshotSignature(snapshot.ownerUserId, snapshot.exportedAt, snapshot.kind, actualChecksum);
  if (snapshot.integrity?.checksum !== actualChecksum || !signaturesMatch(snapshot.integrity?.signature, expectedSignature)) {
    throw new Error("בדיקת התקינות והחתימה של הגיבוי נכשלה.");
  }
  return snapshot;
}

export async function previewBackup(userId: string, runId: string) {
  const admin = createSupabaseAdmin();
  const connection = await getConnection(admin, userId);
  if (!connection) throw new Error("Google Drive is not connected");
  const snapshot = await downloadSnapshot(connection, runId);
  const statusCounts = snapshot.data.tasks.reduce<Record<string, number>>((counts, task) => {
    const status = String(task.status || "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    runId,
    exportedAt: snapshot.exportedAt,
    kind: snapshot.kind,
    taskCount: snapshot.data.tasks.length,
    taxonomyCount: snapshot.data.taxonomy.length,
    shareHistoryCount: snapshot.data.shareHistory.length,
    statusCounts,
    note: "השחזור יעדכן משימות והגדרות. שיתופים נשמרים בגיבוי כתיעוד בלבד ולא ישונו.",
  };
}

export async function restoreBackup(userId: string, runId: string) {
  const admin = createSupabaseAdmin();
  const connection = await getConnection(admin, userId);
  if (!connection) throw new Error("Google Drive is not connected");
  const snapshot = await downloadSnapshot(connection, runId);
  await createBackupForConnection(connection, "pre_restore");
  const { error } = await admin.rpc("restore_drive_backup_snapshot", { p_user_id: userId, p_data: snapshot.data });
  if (error) throw error;
  return { restoredAt: new Date().toISOString(), taskCount: snapshot.data.tasks.length };
}

export async function dismissDriveOnboarding(userId: string) {
  const admin = createSupabaseAdmin();
  const connection = await getConnection(admin, userId);
  const nextCount = Math.min(2, (connection?.onboarding_prompt_count ?? 0) + 1);
  const remindAfter = nextCount === 1 ? new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString() : null;
  const { error } = await admin.from("drive_backup_connections").upsert({
    user_id: userId,
    onboarding_prompt_count: nextCount,
    remind_after: remindAfter,
    timezone: connection?.timezone ?? "Asia/Jerusalem",
    status: connection?.status ?? "disconnected",
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
}

export async function disconnectDrive(userId: string) {
  const admin = createSupabaseAdmin();
  const connection = await getConnection(admin, userId);
  if (connection?.encrypted_refresh_token) {
    const token = decryptToken(connection.encrypted_refresh_token);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }).catch(() => undefined);
  }
  const { error } = await admin.from("drive_backup_connections").upsert({
    user_id: userId,
    google_email: null,
    folder_id: null,
    encrypted_refresh_token: null,
    status: "disconnected",
    disconnected_at: new Date().toISOString(),
    remind_after: null,
    onboarding_prompt_count: 2,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
}

export async function deleteAllDriveBackups(userId: string) {
  const admin = createSupabaseAdmin();
  const connection = await getConnection(admin, userId);
  if (!connection?.encrypted_refresh_token) throw new Error("יש למחוק את הגיבויים לפני ניתוק חשבון Drive.");
  const accessToken = await refreshAccessToken(connection.encrypted_refresh_token);
  const { data, error } = await admin.from("drive_backup_runs").select("id,file_id").eq("user_id", userId).is("deleted_at", null);
  if (error) throw error;
  for (const run of data ?? []) {
    await deleteDriveFile(accessToken, run.file_id);
    await admin.from("drive_backup_runs").update({ deleted_at: new Date().toISOString() }).eq("id", run.id);
  }
}

export async function runScheduledBackups() {
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.from("drive_backup_connections").select("*").not("encrypted_refresh_token", "is", null).neq("status", "disconnected");
  if (error) throw error;
  const results: { userId: string; hourly: string; daily?: string }[] = [];
  for (const connection of (data ?? []) as DriveConnection[]) {
    const result = { userId: connection.user_id, hourly: "pending" };
    try {
      await createBackupForConnection(connection, "hourly");
      result.hourly = "ok";
      const local = localDateParts(connection.timezone);
      if (local.hour === 3) {
        const { data: existingDaily } = await admin.from("drive_backup_runs").select("id").eq("user_id", connection.user_id)
          .eq("backup_kind", "daily").eq("local_date", local.date).is("deleted_at", null).maybeSingle();
        if (!existingDaily) {
          try {
            await createBackupForConnection(connection, "daily");
            Object.assign(result, { daily: "ok" });
          } catch (dailyError) {
            Object.assign(result, { daily: dailyError instanceof Error ? dailyError.message : "failed" });
          }
        } else Object.assign(result, { daily: "already-created" });
      }
    } catch (runError) {
      result.hourly = runError instanceof Error ? runError.message : "failed";
    }
    results.push(result);
  }
  return results;
}
