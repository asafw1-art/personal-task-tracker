import type { AssistantContextPreview } from "@/lib/assistantPrivacy";
import { recordServiceHealth } from "@/lib/server/serviceHealth";

export type ProviderId = "gemini" | "gateway";
const PROVIDER_BUDGET_MS = 18_000;
const ATTEMPT_TIMEOUT_MS = 12_000;
// Best-effort protection within a warm server instance, not a distributed quota.
const cooldowns = new Map<ProviderId, { model: string; until: number }>();

export function retryAfterMs(value: string | null, now = Date.now()) {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

export function providerHttpError(status: number) {
  if (status === 429) return "rate_limited";
  if (status === 402) return "credits_exhausted";
  if (status === 404) return "model_unavailable";
  if (status === 401) return "unauthorized";
  if (status === 403) return "access_denied";
  if ([400, 422].includes(status)) return "invalid_request";
  if ([502, 503].includes(status)) return "overloaded";
  if ([408, 504].includes(status)) return "timeout";
  return "provider_error";
}
export function normalizeGeminiModel(model: string | undefined) {
  const value = model?.trim().replace(/^models\//, "");
  if (!value || ["3.6", "gemini-2.0-flash", "gemini-2.5-flash", "gemini-3-flash-preview"].includes(value)) return "gemini-3.6-flash";
  return value === "3.5" ? "gemini-3.5-flash" : value;
}

export function providerConfiguration() {
  const disabled = new Set((process.env.ASSISTANT_DISABLED_PROVIDERS ?? "").split(",").map((value) => value.trim()));
  return ([
    { id: "gemini", label: "Gemini", model: normalizeGeminiModel(process.env.GEMINI_MODEL), configured: Boolean(process.env.GEMINI_API_KEY) },
    { id: "gateway", label: "Vercel AI Gateway", model: process.env.ASSISTANT_MODEL?.trim() || "", configured: Boolean((process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY) && process.env.ASSISTANT_MODEL?.trim()) },
  ] as const).map((item) => ({ ...item, enabled: !disabled.has(item.id),
    // Exact model attestation is server-only. It does not turn on billing or add a provider.
    privacyVerified: Boolean(item.model && process.env[`ASSISTANT_${item.id.toUpperCase()}_REVIEWED_MODEL`] === item.model),
  }));
}

export function availableRecipients(): AssistantContextPreview["providers"] {
  return providerConfiguration().filter((item) => item.configured && item.enabled)
    .map(({ id, label, model, privacyVerified }) => ({ id, label, model, privacyVerified }));
}

export function providerErrorCode(error: unknown): string {
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return "timeout";
  return "network_error";
}

async function callProvider(id: ProviderId, systemPrompt: string, payload: unknown, timeoutMs: number) {
  const config = providerConfiguration().find((item) => item.id === id)!;
  if (!config.enabled || !config.configured) return { error: config.enabled ? "not_configured" : "disabled_by_operator" };
  const isGemini = id === "gemini";
  const url = isGemini
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`
    : "https://ai-gateway.vercel.sh/v1/chat/completions";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: isGemini
        ? { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! }
        : { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY}` },
      body: JSON.stringify(isGemini ? {
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n${JSON.stringify(payload)}` }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048 },
      } : {
        model: config.model, stream: false, temperature: 0.2, max_tokens: 2048,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(payload) }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const error = providerHttpError(response.status);
      const retryMs = retryAfterMs(response.headers.get("retry-after"));
      if (retryMs || [429, 503].includes(response.status)) {
        cooldowns.set(id, { model: config.model, until: Date.now() + (retryMs || 30_000) });
      }
      // Never read or log a provider error body: it can echo private input.
      await response.body?.cancel();
      return { error, httpStatus: response.status };
    }
    const data = await response.json();
    if (isGemini ? data.candidates?.[0]?.finishReason === "MAX_TOKENS" : data.choices?.[0]?.finish_reason === "length") return { error: "truncated_response" };
    const content = isGemini
      ? data.candidates?.[0]?.content?.parts?.filter((part: { thought?: boolean }) => !part.thought).map((part: { text?: string }) => part.text ?? "").join("").trim()
      : data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim() || content.length > 20000) return { error: "invalid_response" };
    return { content, provider: config.label };
  } catch (error) {
    return { error: error instanceof SyntaxError ? "invalid_response" : providerErrorCode(error) };
  }
}

export async function callApprovedProviders(systemPrompt: string, payload: unknown, approved: AssistantContextPreview["providers"], validate: (content: string) => boolean, probe = false, requestDeadline = Infinity) {
  const deadline = Math.min(requestDeadline, Date.now() + PROVIDER_BUDGET_MS);
  for (const config of providerConfiguration()) {
    // Recheck policy at the actual outbound boundary, including fallback.
    if (!config.configured || !config.enabled || !approved.some((item) => item.id === config.id && item.model === config.model)) continue;
    const cooldown = cooldowns.get(config.id);
    if (cooldown?.model === config.model && cooldown.until > Date.now()) continue;
    const remaining = deadline - Date.now();
    if (remaining < 100) break;
    const checkedAt = new Date(Date.now()).toISOString();
    const result = await callProvider(config.id, systemPrompt, payload, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    let valid = false;
    try { valid = Boolean(result.content && validate(result.content)); } catch { /* Invalid output must still reach fallback. */ }
    const reason = valid ? "ok" : result.error || "invalid_response";
    // Metadata only; a monitoring outage must not indefinitely delay an answer.
    console.info("assistant_provider_attempt", { provider: config.id, reason, httpStatus: result.httpStatus, elapsedMs: Date.now() - Date.parse(checkedAt) });
    const healthBudget = Math.min(750, deadline - Date.now());
    if (healthBudget > 0) await recordServiceHealth(config.id, valid ? "healthy" : ["rate_limited", "overloaded"].includes(reason) ? "degraded" : "error", reason, probe ? "probe" : "request", checkedAt, healthBudget);
    if (valid) return result;
  }
  return null;
}
