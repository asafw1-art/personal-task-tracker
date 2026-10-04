import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("src/lib/server/assistantProviders.ts", "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const originalFetch = globalThis.fetch, originalNow = Date.now, originalTimeout = AbortSignal.timeout, originalInfo = console.info;
let now = 1_800_000_000_000;
const calls = [], health = [], budgets = [], logs = [];
Date.now = () => now;
AbortSignal.timeout = (ms) => { budgets.push(ms); return new AbortController().signal; };
console.info = (...args) => logs.push(args);
function fresh() {
  calls.length = health.length = budgets.length = 0;
  Object.assign(process.env, { GEMINI_API_KEY: "synthetic", GEMINI_MODEL: "synthetic-model", AI_GATEWAY_API_KEY: "synthetic", ASSISTANT_MODEL: "test/model", ASSISTANT_DISABLED_PROVIDERS: "" });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    assert.equal(name, "@/lib/server/serviceHealth");
    return { recordServiceHealth: async (...args) => { health.push(args); now += Math.min(10, args[5]); return true; } };
  }, loaded, loaded.exports);
  return loaded.exports;
}
const reply = JSON.stringify({ reply: "תשובת בדיקה" });
const ok = (url) => Response.json(url.includes("googleapis")
  ? { candidates: [{ content: { parts: [{ thought: true, text: "PRIVATE_THOUGHT" }, { text: reply }] } }] }
  : { choices: [{ message: { content: reply } }] });
function network(handler) {
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return handler(url, init); };
}
const valid = (content) => Boolean(JSON.parse(content).reply?.trim());
const run = (api, approved = api.availableRecipients(), validator = valid, deadline) => api.callApprovedProviders("SYNTHETIC_PROMPT", { userMessage: "בדיקה" }, approved, validator, false, deadline);
try {
  let api = fresh();
  network(ok);
  assert.equal((await run(api)).provider, "Gemini");
  assert.equal(calls.length, 1);
  assert.equal(health[0][2], "ok");

  for (const [status, reason] of [[400, "invalid_request"], [401, "unauthorized"], [402, "credits_exhausted"], [403, "access_denied"], [404, "model_unavailable"], [429, "rate_limited"], [503, "overloaded"], [504, "timeout"], [500, "provider_error"]]) {
    api = fresh();
    network((url) => url.includes("googleapis") ? new Response("PRIVATE_ERROR_BODY", { status }) : ok(url));
    assert.equal((await run(api)).provider, "Vercel AI Gateway");
    assert.equal(health[0][2], reason);
    assert.deepEqual(calls[0].body.contents[0].parts[0].text.split("\n").at(-1), calls[1].body.messages[1].content);
  }

  for (const malformed of ["not-json", JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"reply":" "}' }] } }] }), JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: "MAX_TOKENS" }] })]) {
    api = fresh();
    network((url) => url.includes("googleapis") ? new Response(malformed) : ok(url));
    assert.equal((await run(api)).provider, "Vercel AI Gateway");
    assert.ok(["invalid_response", "truncated_response"].includes(health[0][2]));
  }

  api = fresh();
  network(() => new Response("PRIVATE_ERROR_BODY", { status: 503, headers: { "retry-after": "120" } }));
  assert.equal(await run(api), null);
  assert.equal(calls.length, 2);
  assert.equal(await run(api), null);
  assert.equal(calls.length, 2, "Retry-After prevents repeated calls in the same server instance");
  now += 120_001;
  network(ok);
  assert.equal((await run(api)).provider, "Gemini");
  assert.equal(api.retryAfterMs("120"), 120_000);
  assert.equal(api.retryAfterMs(new Date(now + 60_000).toUTCString()), 60_000 - now % 1000);
  assert.equal(api.retryAfterMs("bad"), 0);
  assert.equal(api.retryAfterMs("-1"), 0);

  api = fresh();
  process.env.ASSISTANT_DISABLED_PROVIDERS = "gateway";
  network(() => new Response("", { status: 500 }));
  assert.equal(await run(api), null);
  assert.equal(calls.length, 1);
  api = fresh();
  assert.equal(await run(api, [{ id: "gemini", model: "changed-model" }]), null);
  assert.equal(calls.length, 0, "No outbound request without approval of the current model");

  api = fresh();
  network(() => { now += budgets.at(-1); throw new DOMException("Timeout", "TimeoutError"); });
  const started = now;
  assert.equal(await run(api), null);
  assert.deepEqual(budgets, [12_000, 5_990]);
  assert.equal(now - started, 18_000, "Both attempts and health recording share one budget");
  assert.equal(calls.length, 2);
  api = fresh();
  assert.equal(await run(api, undefined, valid, now - 1), null);
  assert.equal(calls.length, 0, "Do not start a provider after the request deadline");
  api = fresh();
  network(ok);
  let validations = 0;
  assert.equal((await run(api, undefined, () => { if (!validations++) throw new Error("bad output"); return true; })).provider, "Vercel AI Gateway");
  assert.ok(!JSON.stringify(logs).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(health).includes("PRIVATE_"));
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  AbortSignal.timeout = originalTimeout;
  console.info = originalInfo;
}
console.log("PASS: primary/fallback, classified HTTP failures, invalid/empty/truncated replies, thought exclusion, exact consent, disabled fallback, Retry-After, deadline, metadata-only logs.");

const healthCode = ts.transpileModule(readFileSync("src/lib/server/serviceHealth.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const healthModule = { exports: {} };
let healthAborted = false;
new Function("require", "module", "exports", healthCode)(() => ({ createSupabaseAdmin: () => ({
  rpc: () => ({ abortSignal: (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { healthAborted = true; resolve({ error: new Error("synthetic timeout") }); }, { once: true });
  }) }),
}) }), healthModule, healthModule.exports);
const keepAlive = setTimeout(() => {}, 1000);
const originalError = console.error;
try {
  console.error = () => {};
  assert.equal(await healthModule.exports.recordServiceHealth("gemini", "healthy", "ok", "request", new Date().toISOString(), 15), false);
  assert.equal(healthAborted, true, "Monitoring persistence is abortable");
} finally { clearTimeout(keepAlive); console.error = originalError; }
console.log("PASS: monitoring timeout aborts without failing the provider response.");
