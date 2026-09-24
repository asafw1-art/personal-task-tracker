import type { AssistantContextPreview } from "@/lib/assistantPrivacy";
import { recordServiceHealth } from "@/lib/server/serviceHealth";

export type ProviderId = "gemini" | "gateway";
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

async function callProvider(id: ProviderId, systemPrompt: string, payload: unknown) {
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
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { error: response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "unauthorized" : "provider_error" };
    const data = await response.json();
    const content = isGemini
      ? data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("").trim()
      : data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content || content.length > 20000) return { error: "invalid_response" };
    return { content, provider: config.label };
  } catch (error) {
    return { error: providerErrorCode(error) };
  }
}

export async function callApprovedProviders(systemPrompt: string, payload: unknown, approved: AssistantContextPreview["providers"], validate: (content: string) => boolean, probe = false) {
  for (const config of providerConfiguration()) {
    // Recheck policy at the actual outbound boundary, including fallback.
    if (!config.configured || !config.enabled || !approved.some((item) => item.id === config.id && item.model === config.model)) continue;
    const checkedAt = new Date().toISOString();
    const result = await callProvider(config.id, systemPrompt, payload);
    const valid = Boolean(result.content && validate(result.content));
    await recordServiceHealth(config.id, valid ? "healthy" : result.error === "rate_limited" ? "degraded" : "error", valid ? "ok" : result.error || "invalid_response", probe ? "probe" : "request", checkedAt);
    if (valid) return result;
  }
  return null;
}
