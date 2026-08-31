import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

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
