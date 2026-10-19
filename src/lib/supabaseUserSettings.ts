import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { loadPersistenceContext, versionedPersistenceEnabled, writeVersioned } from "@/lib/persistenceWriters";
const settingsBases = new Map<string, { revision: string; epoch: string; value: Record<string, unknown> }>();

export type UserSettings = {
  displayName?: string;
  notificationPreferences?: Record<string, boolean>;
  analyticsPreferences?: { stuckThresholdDays?: number };
  theme?: "light" | "dark";
};

type UserSettingsRow = {
  display_name: string | null;
  notification_preferences?: Record<string, boolean> | null;
  analytics_preferences?: { stuckThresholdDays?: number } | null;
  theme?: "light" | "dark" | null;
};

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

function isMissingSettingsTable(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "";
  return message.includes("user_settings") || message.includes("schema cache");
}

function missingSettingsTableError() {
  return new Error("חסרה טבלת user_settings בענן. יש להריץ ב-Supabase את supabase/add-focus-and-user-settings.sql.");
}

export async function fetchUserSettings(user: User): Promise<UserSettings> {
  if (versionedPersistenceEnabled) {
    const context = await loadPersistenceContext(user.id);
    const row = context.settings ?? {};
    settingsBases.set(user.id, { revision: context.settingsRevision, epoch: context.writeEpoch, value: { ...row } });
    return { displayName: (row.display_name as string | null)?.trim() || undefined,
      notificationPreferences: row.notification_preferences as UserSettings["notificationPreferences"],
      analyticsPreferences: row.analytics_preferences as UserSettings["analyticsPreferences"], theme: row.theme as UserSettings["theme"] };
  }
  const client = requireSupabase();
  const { data, error } = await client
    .from("user_settings")
    .select("display_name, notification_preferences, analytics_preferences, theme")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    if (isMissingSettingsTable(error)) throw missingSettingsTableError();
    throw error;
  }

  const row = data as UserSettingsRow | null;
  return {
    displayName: row?.display_name?.trim() || undefined,
    notificationPreferences: row?.notification_preferences ?? undefined,
    analyticsPreferences: row?.analytics_preferences ?? undefined,
    theme: row?.theme ?? undefined,
  };
}

export async function saveUserSettings(user: User, settings: UserSettings) {
  if (versionedPersistenceEnabled) {
    const base = settingsBases.get(user.id);
    if (!base) throw new Error("יש לטעון את ההגדרות לפני שמירה.");
    const patch: Record<string, unknown> = {};
    for (const [key, column] of [["displayName", "display_name"], ["notificationPreferences", "notification_preferences"], ["analyticsPreferences", "analytics_preferences"], ["theme", "theme"]] as const) {
      if (key in settings) {
        const value = settings[key] ?? null;
        if (JSON.stringify(value) !== JSON.stringify(base.value[column] ?? null)) patch[column] = value;
      }
    }
    if (!Object.keys(patch).length) return;
    const result = await writeVersioned(user.id, { kind: "save_settings", expectedWriteEpoch: base.epoch,
      expectedDomainRevision: base.revision, patch });
    settingsBases.set(user.id, { ...base, revision: String(result.revision), value: { ...base.value, ...patch } });
    return;
  }
  const client = requireSupabase();
  const row: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  if ("displayName" in settings) row.display_name = settings.displayName?.trim() || null;
  if ("notificationPreferences" in settings) row.notification_preferences = settings.notificationPreferences ?? null;
  if ("analyticsPreferences" in settings) row.analytics_preferences = settings.analyticsPreferences ?? null;
  if ("theme" in settings) row.theme = settings.theme ?? null;
  const { error } = await client
    .from("user_settings")
    .upsert(row, { onConflict: "user_id" });

  if (error) {
    if (isMissingSettingsTable(error)) throw missingSettingsTableError();
    throw error;
  }
}
