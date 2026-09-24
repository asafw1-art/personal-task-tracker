import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { ServiceHealthOverview, ServiceId } from "@/lib/serviceHealth";

export function useServiceHealth(userId: string | undefined, isAdmin: boolean) {
  const [result, setResult] = useState<{ userId: string; overview: ServiceHealthOverview } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (probe?: ServiceId) => {
    if (!isAdmin || !userId || !supabase) return;
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user.id !== userId) return;
      const response = await fetch("/api/admin/services", {
        method: probe ? "POST" : "GET",
        headers: { Authorization: `Bearer ${data.session.access_token}`, ...(probe ? { "Content-Type": "application/json" } : {}) },
        ...(probe ? { body: JSON.stringify({ service: probe }) } : {}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "לא ניתן לקרוא מצב שירותים.");
      setResult({ userId, overview: payload });
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "ניטור השירותים אינו זמין."); }
    finally { setBusy(false); }
  }, [isAdmin, userId]);
  useEffect(() => {
    if (!isAdmin) return;
    const check = () => { if (document.visibilityState === "visible") void refresh(); };
    check();
    const interval = window.setInterval(check, 60000);
    window.addEventListener("focus", check);
    return () => { window.clearInterval(interval); window.removeEventListener("focus", check); };
  }, [isAdmin, refresh]);
  return { overview: isAdmin && result && result.userId === userId ? result.overview : null, error: isAdmin ? error : "", busy, refresh };
}
