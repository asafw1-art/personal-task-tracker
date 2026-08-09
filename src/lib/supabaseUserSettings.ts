import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type UserSettings = {
  displayName?: string;
};

type UserSettingsRow = {
  display_name: string | null;
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
    .select("display_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    if (isMissingSettingsTable(error)) throw missingSettingsTableError();
    throw error;
  }

  const row = data as UserSettingsRow | null;
  return { displayName: row?.display_name?.trim() || undefined };
}

export async function saveUserSettings(user: User, settings: UserSettings) {
  const client = requireSupabase();
  const { error } = await client
    .from("user_settings")
    .upsert({
      user_id: user.id,
      display_name: settings.displayName?.trim() || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (error) {
    if (isMissingSettingsTable(error)) throw missingSettingsTableError();
    throw error;
  }
}
