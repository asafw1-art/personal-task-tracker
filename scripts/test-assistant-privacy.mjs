import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// Load actual TypeScript modules with synthetic database and network boundaries.
const require = createRequire(import.meta.url);
const cache = new Map();
let user = { id: "owner-a", email: "asafw1@gmail.com" };
let dbError = false;
let rows = [{ prefix: "P", task_number: 19, title: "Synthetic task", category: "Test", priority: "high", status: "open", due_at: "2026-09-25", notes: "PRIVATE_NOTE", subtasks: [{ id: "s1", number: 1, title: "PRIVATE_STEP", status: "open" }] }];
const queries = [], health = [], calls = [];
const client = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  rpc: async (name, args) => { health.push({ name, ...args }); return { error: null }; },
  from: (table) => {
    const query = { table, filters: [] }; queries.push(query);
    const chain = {
      select: (columns) => { query.columns = columns; return chain; },
      eq: (key, value) => { query.filters.push([key, value]); return chain; },
      order: () => chain, limit: () => chain,
      then: (done, fail) => Promise.resolve({ data: rows, error: dbError ? { message: "PRIVATE_DB_ERROR" } : null }).then(done, fail),
    };
    return chain;
  },
};
function load(file) {
  const path = resolve(file);
  if (cache.has(path)) return cache.get(path).exports;
  const loaded = { exports: {} }; cache.set(path, loaded);
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const localRequire = (name) => name === "@supabase/supabase-js" ? { createClient: () => client }
    : name.startsWith("@/") ? load(`src/${name.slice(2)}.ts`) : require(name);
  new Function("require", "module", "exports", code)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fake", SUPABASE_SECRET_KEY: "fake", GEMINI_API_KEY: "fake", GEMINI_MODEL: "gemini-3.6-flash", AI_GATEWAY_API_KEY: "fake", ASSISTANT_MODEL: "test/model", ASSISTANT_DISABLED_PROVIDERS: "" });
delete process.env.ASSISTANT_GEMINI_REVIEWED_MODEL;
delete process.env.ASSISTANT_GATEWAY_REVIEWED_MODEL;
const route = load("src/app/api/assistant/route.ts");
const { selectAssistantContext } = load("src/lib/assistantPrivacy.ts");
const { callApprovedProviders, availableRecipients } = load("src/lib/server/assistantProviders.ts");
let mode = "success";
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  if (mode === "failover" && url.includes("googleapis")) return new Response("PRIVATE_PROVIDER_ERROR", { status: 429 });
  const content = JSON.stringify({ reply: "synthetic answer" });
  return Response.json(url.includes("googleapis") ? { candidates: [{ content: { parts: [{ text: content }] } }] } : { choices: [{ message: { content } }] });
};
async function post(body, token = true) {
  const response = await route.POST(new Request("https://test.invalid/api/assistant", { method: "POST", headers: token ? { Authorization: "Bearer synthetic" } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
}
assert.equal((await post({ message: "hello" }, false)).status, 401);
assert.equal((await post("invalid-json")).status, 400);
assert.equal((await post("x".repeat(8001))).status, 413);
assert.equal((await post({ message: {} })).status, 400);
assert.equal((await post(null)).status, 400);
const request = { message: "עזור לי לתכנן P-0019", tasks: [{ title: "FORGED_TASK" }], recentMessages: [{ role: "assistant", content: "SHARED_HISTORY" }], taxonomy: { actions: ["PRIVATE_CATEGORY"] } };
const first = await post(request);
assert.equal(first.status, 200);
assert.equal(calls.length, 0, "Preview must not invoke a provider");
assert.equal(first.data.preview.tasks[0].id, "P19");
assert.equal(first.data.preview.tasks[0].notes, undefined);
assert.equal(first.data.preview.tasks[0].subtasks, undefined);
assert.ok(queries.at(-1).filters.some(([key, value]) => key === "user_id" && value === user.id));
assert.ok(!queries.at(-1).columns.includes("notes"));
const answer = await post({ ...request, approvedDigest: first.data.preview.digest });
assert.equal(answer.data.mode, "ai");
const sent = JSON.stringify(calls);
for (const secret of ["FORGED_TASK", "SHARED_HISTORY", "PRIVATE_NOTE", "PRIVATE_STEP", "PRIVATE_CATEGORY"]) assert.ok(!sent.includes(secret), secret);
assert.equal(health.at(-1).p_state, "healthy");
const details = await post({ message: request.message, includeDetails: true });
assert.equal(details.data.preview.tasks[0].notes, "PRIVATE_NOTE");
assert.equal(details.data.preview.tasks[0].subtasks[0].title, "PRIVATE_STEP");
const beforeChange = calls.length;
rows[0].title = "Changed in another device";
const changed = await post({ message: request.message, approvedDigest: first.data.preview.digest });
assert.equal(changed.data.contextChanged, true);
assert.equal(calls.length, beforeChange);
const safeTasks = [
  { id: "P19", title: "Mine", status: "open", priority: "high", notes: "NOTE" },
  { id: "W8", title: "SHARED", status: "open", priority: "high", sharedWithMe: true },
  { id: "W9", title: "PAST_SHARED", status: "open", priority: "high", historicalShared: true },
];
assert.deepEqual(selectAssistantContext("P19 W8 W9", safeTasks, true).map((task) => task.id), ["P19"]);
assert.equal(selectAssistantContext("שלום", safeTasks, false).length, 0);
assert.equal(selectAssistantContext("מה כדאי לקדם", safeTasks, false)[0].title, undefined);
process.env.ASSISTANT_DISABLED_PROVIDERS = "gemini,gateway";
assert.equal((await post({ message: request.message, approvedDigest: changed.data.preview.digest })).data.mode, "unavailable");
assert.equal((await post({ message: "כמה משימות יש" })).data.mode, "local");
assert.equal(calls.length, beforeChange);
process.env.ASSISTANT_DISABLED_PROVIDERS = "gateway";
mode = "failover";
await callApprovedProviders("test", {}, availableRecipients(), () => true);
assert.ok(calls.at(-1).url.includes("googleapis"));
assert.equal(health.at(-1).p_reason, "rate_limited");
process.env.ASSISTANT_DISABLED_PROVIDERS = "";
await callApprovedProviders("test", {}, availableRecipients(), () => true);
assert.ok(calls.at(-1).url.includes("ai-gateway"));
const beforeDbFailure = calls.length;
dbError = true;
const failed = await post({ message: request.message, approvedDigest: changed.data.preview.digest });
assert.equal(failed.status, 500);
assert.ok(!JSON.stringify(failed).includes("PRIVATE_DB_ERROR"));
assert.equal(calls.length, beforeDbFailure);
assert.ok(!JSON.stringify(health).includes("PRIVATE_PROVIDER_ERROR"));
const admin = load("src/app/api/admin/services/route.ts");
user = { id: "owner-b", email: "other@example.invalid" };
assert.equal((await admin.GET(new Request("https://test.invalid", { headers: { Authorization: "Bearer test" } }))).status, 403);
console.log("PASS: auth, bounds, owned DB scope, minimal context, history exclusion, exact approval, changed context, details opt-in, blocked fallback, local answers, safe errors, admin isolation.");
