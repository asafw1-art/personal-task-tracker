import { createSupabaseAdmin } from "@/lib/server/supabaseServer";
import type { ServiceId, ServiceState } from "@/lib/serviceHealth";

export async function recordServiceHealth(id: ServiceId, state: ServiceState, reason: string, source: "request" | "probe" | "policy" | "scheduler", checkedAt = new Date().toISOString(), timeoutMs = 2_000) {
  try {
    const { error } = await createSupabaseAdmin().rpc("record_service_health", {
      p_service_id: id, p_state: state, p_reason: reason, p_source: source, p_checked_at: checkedAt,
    }).abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) throw new Error("monitoring_unavailable");
    return true;
  } catch {
    console.error("Service health persistence unavailable", { service: id });
    return false;
  }
}
