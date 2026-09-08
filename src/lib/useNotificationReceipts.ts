"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type Receipt = { event_key: string; kind: "read" | "announced" };
type Cache = { receipts: Receipt[]; pending: Receipt[] };
const keyFor = (userId: string) => `task-notification-receipts-v1:${userId}`;
const identity = (receipt: Receipt) => `${receipt.kind}:${receipt.event_key}`;
const merge = (...groups: Receipt[][]) => [...new Map(groups.flat().map((item) => [identity(item), item])).values()];

function readCache(userId: string): Cache {
  try {
    const value = JSON.parse(localStorage.getItem(keyFor(userId)) || "{}");
    const valid = (items: unknown): Receipt[] => Array.isArray(items) ? items.filter((item) => (
      item && typeof item.event_key === "string" && item.event_key.length <= 500
      && (item.kind === "read" || item.kind === "announced")
    )) : [];
    return { receipts: valid(value.receipts), pending: valid(value.pending) };
  } catch { return { receipts: [], pending: [] }; }
}

export function useNotificationReceipts(userId: string | undefined) {
  const [state, setState] = useState<{ userId?: string; receipts: Receipt[]; ready: boolean; error: string }>({ receipts: [], ready: false, error: "" });
  const activeUser = useRef(userId);
  useEffect(() => { activeUser.current = userId; }, [userId]);

  const publish = useCallback((owner: string, cache: Cache, ready: boolean, error = "") => {
    if (activeUser.current !== owner) return;
    try { localStorage.setItem(keyFor(owner), JSON.stringify(cache)); } catch { /* Cloud receipts remain authoritative when storage is unavailable. */ }
    setState({ userId: owner, receipts: cache.receipts, ready, error });
  }, []);

  const refresh = useCallback(async () => {
    if (!userId || !supabase) return;
    const cache = readCache(userId);
    try {
      if (cache.pending.length) {
        const { error } = await supabase.from("notification_receipts").upsert(
          cache.pending.map((item) => ({ ...item, user_id: userId })),
          { onConflict: "user_id,event_key,kind", ignoreDuplicates: true },
        );
        if (error) throw error;
      }
      const receipts: Receipt[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase.from("notification_receipts")
          .select("event_key,kind").eq("user_id", userId).order("event_key").order("kind").range(offset, offset + 999);
        if (error) throw error;
        receipts.push(...data as Receipt[]);
        if (data.length < 1000) break;
      }
      const current = readCache(userId);
      const sent = new Set(cache.pending.map(identity));
      publish(userId, { receipts: merge(current.receipts, receipts), pending: current.pending.filter((item) => !sent.has(identity(item))) }, true);
    } catch {
      publish(userId, readCache(userId), false, "מצב הקריאה נשמר במכשיר; הסנכרון לענן אינו זמין כרגע.");
    }
  }, [publish, userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [refresh]);

  const markRead = useCallback((keys: string[]) => {
    if (!userId) return;
    const cache = readCache(userId);
    const receipts: Receipt[] = [...new Set(keys)].map((event_key) => ({ event_key, kind: "read" }));
    publish(userId, { receipts: merge(cache.receipts, receipts), pending: merge(cache.pending, receipts) }, state.ready);
    void refresh();
  }, [publish, refresh, state.ready, userId]);

  const claimAnnouncement = useCallback(async (keys: string[]) => {
    if (!userId || !supabase || !keys.length) return false;
    const { data, error } = await supabase.from("notification_receipts").upsert(
      [...new Set(keys)].map((event_key) => ({ user_id: userId, event_key, kind: "announced" })),
      { onConflict: "user_id,event_key,kind", ignoreDuplicates: true },
    ).select("event_key,kind");
    if (error || activeUser.current !== userId) return false;
    const cache = readCache(userId);
    publish(userId, { ...cache, receipts: merge(cache.receipts, keys.map((event_key) => ({ event_key, kind: "announced" as const }))) }, true);
    return Boolean(data?.length);
  }, [publish, userId]);

  const current = state.userId === userId ? state : { receipts: [], ready: false, error: "" };
  return {
    read: new Set(current.receipts.filter((item) => item.kind === "read").map((item) => item.event_key)),
    announced: new Set(current.receipts.filter((item) => item.kind === "announced").map((item) => item.event_key)),
    ready: current.ready, error: current.error, markRead, claimAnnouncement,
  };
}
