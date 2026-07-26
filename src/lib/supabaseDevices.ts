import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

const DEVICE_STORAGE_KEY = "asaf-task-tracker-device-id";

export type DeviceType = "mobile" | "tablet" | "desktop" | "unknown";

export type UserDevice = {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  browserName: string;
  lastSeenAt: string;
  isCurrent: boolean;
};

type DeviceRow = {
  device_id: string;
  device_name: string;
  device_type: DeviceType;
  browser_name: string;
  last_seen_at: string;
};

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

function getDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) return existing;

  const next = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, next);
  return next;
}

function detectDeviceType(userAgent: string): DeviceType {
  const normalized = userAgent.toLowerCase();
  if (/ipad|tablet/.test(normalized)) return "tablet";
  if (/mobile|android|iphone|ipod/.test(normalized)) return "mobile";
  if (userAgent) return "desktop";
  return "unknown";
}

function detectBrowserName(userAgent: string) {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/CriOS\//.test(userAgent)) return "Chrome iOS";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return "Safari";
  return "דפדפן לא מזוהה";
}

function deviceTypeLabel(deviceType: DeviceType) {
  if (deviceType === "mobile") return "נייד";
  if (deviceType === "tablet") return "טאבלט";
  if (deviceType === "desktop") return "מחשב";
  return "מכשיר";
}

function buildDeviceProfile() {
  const userAgent = window.navigator.userAgent;
  const deviceType = detectDeviceType(userAgent);
  const browserName = detectBrowserName(userAgent);
  return {
    deviceId: getDeviceId(),
    deviceName: `${deviceTypeLabel(deviceType)} - ${browserName}`,
    deviceType,
    browserName,
  };
}

function rowToDevice(row: DeviceRow, currentDeviceId: string): UserDevice {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    deviceType: row.device_type,
    browserName: row.browser_name,
    lastSeenAt: row.last_seen_at,
    isCurrent: row.device_id === currentDeviceId,
  };
}

export function getCurrentDeviceId() {
  if (typeof window === "undefined") return "";
  return getDeviceId();
}

export async function registerCurrentDevice(user: User) {
  const client = requireSupabase();
  const profile = buildDeviceProfile();
  const now = new Date().toISOString();
  const { error } = await client
    .from("user_devices")
    .upsert({
      user_id: user.id,
      device_id: profile.deviceId,
      device_name: profile.deviceName,
      device_type: profile.deviceType,
      browser_name: profile.browserName,
      last_seen_at: now,
      updated_at: now,
    }, {
      onConflict: "user_id,device_id",
    });

  if (error) throw error;
  return profile.deviceId;
}

export async function fetchUserDevices(currentDeviceId = getCurrentDeviceId()) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("user_devices")
    .select("device_id, device_name, device_type, browser_name, last_seen_at")
    .order("last_seen_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => rowToDevice(row as DeviceRow, currentDeviceId));
}
