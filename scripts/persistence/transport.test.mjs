import assert from "node:assert/strict";
import { after, test } from "node:test";
import { command, syntheticSeed as seed } from "./contract-cases.mjs";
import { loadIsolatedModule as load } from "./fixtures.mjs";

const originalFetch = globalThis.fetch;
const envNames = ["PERSISTENCE_V1_ENABLED", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
after(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
const resultFor = (value) => ({ status: "committed", operationId: value.operationId, targetTaskUuid: seed.tasks[0].id,
  revision: "2", writeEpoch: "1", task: { ...seed.tasks[0], revision: "2" } });
function server() {
  process.env.PERSISTENCE_V1_ENABLED = "true";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "synthetic-public-key";
  const calls = [], verified = [];
  let handler = async (_name, args) => ({ data: resultFor(args.p_command), error: null });
  class AuthError extends Error { constructor() { super("Synthetic auth failure"); this.status = 401; } }
  const api = load("src/lib/server/persistenceTransport.ts", {
    "@/lib/server/supabaseServer": { RequestAuthError: AuthError, verifyRequestUser: async (request) => {
      verified.push(true);
      if (request.headers.get("authorization") !== "Bearer synthetic-token") throw new AuthError();
      return { id: seed.owner };
    } },
    "@supabase/supabase-js": { createClient: (url, key, options) => {
      assert.equal(url, "https://synthetic.invalid"); assert.equal(key, "synthetic-public-key");
      assert.equal(options.global.headers.Authorization, "Bearer synthetic-token");
      assert.equal(options.auth.persistSession, false);
      return { rpc: async (name, args) => { calls.push({ name, args }); return handler(name, args); } };
    } },
  });
  return { api, calls, verified, use: (fn) => { handler = fn; } };
}
function post(body = command(), extra = {}) {
  return new Request("https://synthetic.invalid/api/persistence", { method: "POST", headers: {
    Authorization: "Bearer synthetic-token", "Content-Type": "application/json", ...extra,
  }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const get = (query = "", auth = "Bearer synthetic-token") => new Request(`https://synthetic.invalid/api/persistence${query}`, { headers: { Authorization: auth } });

test("H01: disabled endpoint never authenticates, reads a body or dispatches", async () => {
  const h = server(); process.env.PERSISTENCE_V1_ENABLED = "false";
  const response = await h.api.handlePersistenceRequest(post("not-json"), "POST");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "client_upgrade_required");
  assert.equal(h.calls.length, 0); assert.equal(h.verified.length, 0);
});
test("H02: expired/missing authorization returns 401 without a database call", async () => {
  const h = server();
  assert.equal((await h.api.handlePersistenceRequest(get("", "Bearer expired"), "GET")).status, 401);
  assert.equal(h.calls.length, 0);
});
test("H03: command uses verified user's JWT and publishable key, never admin credentials", async () => {
  const h = server(), value = command();
  const response = await h.api.handlePersistenceRequest(post(value), "POST");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).operationId, value.operationId);
  assert.deepEqual(h.calls, [{ name: "persistence_command_v1", args: { p_command: value } }]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Authorization");
});
test("H04: invalid JSON, media type, envelope and announced/actual oversized bodies do not dispatch", async () => {
  const h = server();
  for (const [request, expected] of [[post("{"), 400], [post([], {}), 400], [post({ operationId: "bad" }), 400],
    [post({}, { "Content-Type": "text/plain" }), 415], [post({}, { "Content-Length": "70000" }), 413],
    [post({ operationId: command().operationId, patch: "x".repeat(65536) }), 413]]) {
    assert.equal((await h.api.handlePersistenceRequest(request, "POST")).status, expected);
  }
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(40000)); controller.close(); } });
  const request = new Request("https://synthetic.invalid/api/persistence", { method: "POST", headers: {
    Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
  }, body: stream, duplex: "half" });
  assert.equal((await h.api.handlePersistenceRequest(request, "POST")).status, 413);
  assert.equal(h.calls.length, 0);
});
test("H05: known database outcomes retain distinct HTTP statuses", async () => {
  const h = server();
  for (const [status, expected] of [["conflict", 409], ["stale_epoch", 409], ["idempotency_mismatch", 409],
    ["validation_failed", 422], ["account_read_only", 423], ["client_upgrade_required", 426], ["not_found_or_forbidden", 404]]) {
    h.use(async () => ({ data: { status }, error: null }));
    assert.equal((await h.api.handlePersistenceRequest(post(), "POST")).status, expected);
  }
});
test("H06: errors after dispatch remain unknown and cannot leak private diagnostics", async () => {
  for (const fail of [async () => { throw new Error("SYNTHETIC_PRIVATE_ERROR"); },
    async () => ({ data: null, error: { message: "SYNTHETIC_PRIVATE_ERROR" } })]) {
    const h = server(), value = command(); h.use(fail);
    const response = await h.api.handlePersistenceRequest(post(value), "POST"), body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.status, "unknown");
    assert.equal(body.operationId, value.operationId);
    assert.equal(JSON.stringify(body).includes("SYNTHETIC_PRIVATE_ERROR"), false);
    assert.equal(h.calls.length, 1, "No fallback or implicit retry");
  }
});
test("H07: receipt lookup and paginated reads use separate RPCs and validate query shape", async () => {
  const h = server(), op = command().operationId;
  h.use(async () => ({ data: { status: "unknown", operationId: op }, error: null }));
  assert.equal((await h.api.handlePersistenceRequest(get(`?operationId=${op}`), "GET")).status, 202);
  assert.equal(h.calls[0].name, "persistence_receipt_v1");
  h.use(async () => ({ data: { status: "ok", tasks: [], complete: true, cursor: null }, error: null }));
  assert.equal((await h.api.handlePersistenceRequest(get("?limit=1"), "GET")).status, 200);
  assert.deepEqual(h.calls[1], { name: "persistence_page_v1", args: { p_limit: 1, p_cursor: null } });
  h.calls.length = 0;
  for (const query of ["?limit=0", "?limit=201", "?cursor=null", "?cursor=%7B", "?limit=1&limit=2", `?operationId=${op}&limit=1`, "?userId=other"]) {
    assert.equal((await h.api.handlePersistenceRequest(get(query), "GET")).status, 400);
  }
  assert.equal(h.calls.length, 0);
});
test("H08: malformed RPC responses never become successful command results", async () => {
  const h = server();
  for (const data of [null, [], { status: "invented" }, "not-json"]) {
    h.use(async () => ({ data, error: null }));
    const response = await h.api.handlePersistenceRequest(post(), "POST");
    assert.equal(response.status, 502); assert.equal((await response.json()).status, "unknown");
  }
});

function client() {
  const calls = []; let session = { user: { id: seed.owner }, access_token: "synthetic-token" };
  const api = load("src/lib/persistenceTransport.ts", { "@/lib/supabase": {
    supabase: { auth: { getSession: async () => ({ data: { session }, error: null }) } },
  } });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(resultFor(JSON.parse(options.body))); };
  return { api, calls, session: (value) => { session = value; } };
}
test("C01: immutable command ID and caller account survive a single dispatch", async () => {
  const h = client(), value = command();
  const reply = await h.api.sendPersistenceCommand(value, seed.owner);
  assert.equal(reply.status, "committed"); assert.equal(reply.requestActorId, seed.owner);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), value);
  assert.equal(h.calls[0].options.headers.Authorization, "Bearer synthetic-token");
});
test("C02: account mismatch and no session block sending, not just UI display", async () => {
  const h = client();
  for (const session of [null, { user: { id: seed.outsider }, access_token: "synthetic-token" }]) {
    h.session(session);
    assert.equal((await h.api.sendPersistenceCommand(command(), seed.owner)).status, "authentication_required");
  }
  assert.equal(h.calls.length, 0);
});
test("C03: lost or malformed responses remain unknown without retrying or regenerating IDs", async () => {
  const h = client(), value = command(); let attempts = 0;
  for (const response of [null, [], { status: "committed" }, { ...resultFor(value), operationId: command().operationId }]) {
    globalThis.fetch = async () => { attempts++; return Response.json(response); };
    const reply = await h.api.sendPersistenceCommand(value, seed.owner);
    assert.equal(reply.status, "unknown"); assert.equal(reply.operationId, value.operationId);
  }
  globalThis.fetch = async () => { attempts++; throw new Error("Synthetic lost ACK"); };
  assert.equal((await h.api.sendPersistenceCommand(value, seed.owner)).status, "unknown");
  assert.equal(attempts, 5);
});
test("C04: partial reads preserve the envelope and do not send a task list back", async () => {
  const h = client(); let requests = 0;
  const page = { status: "ok", tasks: [seed.tasks[0]], complete: false, changeSeq: "0", writeEpoch: "1",
    cursor: { afterId: seed.tasks[0].id, owner: seed.owner, changeSeq: "0", writeEpoch: "1" } };
  globalThis.fetch = async (_url, options) => { requests++; assert.equal(options.method, "GET"); return Response.json(page); };
  assert.deepEqual((await h.api.fetchPersistencePage(seed.owner, null, 1)).tasks, page.tasks);
  assert.equal((await h.api.fetchPersistencePage(seed.owner, null, 1)).complete, false);
  assert.equal(requests, 2);
  assert.equal((await h.api.fetchPersistencePage(seed.owner, null, 300)).status, "validation_failed");
  assert.equal(requests, 2);
});

test("C05: UUID casing is semantic identity, but a different target cannot be acknowledged", async () => {
  const h = client(), value = command(undefined, { operationId: "ABCDEFAB-1234-4123-8123-ABCDEFABCDEF" });
  globalThis.fetch = async () => Response.json({ ...resultFor(value), operationId: value.operationId.toLowerCase() });
  assert.equal((await h.api.sendPersistenceCommand(value, seed.owner)).status, "committed");
  const other = { ...seed.tasks[1], revision: "2" };
  globalThis.fetch = async () => Response.json({ ...resultFor(value), targetTaskUuid: other.id, task: other });
  assert.equal((await h.api.sendPersistenceCommand(value, seed.owner)).status, "unknown");
});

test("C06: request deadline produces unknown with the same ID, never a retry", async () => {
  const h = client(), value = command(), originalTimeout = globalThis.setTimeout;
  let attempts = 0;
  try {
    globalThis.setTimeout = (callback, delay) => { assert.equal(delay, 15000); queueMicrotask(callback); return 0; };
    globalThis.fetch = async (_url, options) => {
      attempts++;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Synthetic deadline")), { once: true }));
    };
    const result = await h.api.sendPersistenceCommand(value, seed.owner);
    assert.equal(result.status, "unknown"); assert.equal(result.operationId, value.operationId); assert.equal(attempts, 1);
  } finally { globalThis.setTimeout = originalTimeout; }
});

test("C07: preparation is not commit and requires an actor-bound proposal preview", async () => {
  const h = client(), value = command(undefined, { kind: "prepare_ai_proposal", patch: undefined, messageId: seed.tasks[1].id });
  const prepared = { status: "prepared", operationId: value.operationId, proposalId: value.messageId, commandPreview: { kind: "set_task_status", status: "waiting" } };
  globalThis.fetch = async () => Response.json(prepared);
  assert.equal((await h.api.sendPersistenceCommand(value, seed.owner)).status, "prepared");
  globalThis.fetch = async () => Response.json({ ...prepared, commandPreview: [] });
  assert.equal((await h.api.sendPersistenceCommand(value, seed.owner)).status, "unknown");
  globalThis.fetch = async () => Response.json(prepared);
  assert.equal((await h.api.sendPersistenceCommand({ ...value, kind: "patch_task" }, seed.owner)).status, "unknown");
});
test("C08: only ending access can acknowledge commit without returning task content", async () => {
  const h = client(), value = command(undefined, { kind: "leave_share", patch: undefined, shareId: seed.tasks[1].id });
  const metadata = resultFor(value); delete metadata.task;
  globalThis.fetch = async () => Response.json(metadata);
  assert.equal((await h.api.sendPersistenceCommand(value, seed.owner)).status, "committed");
  assert.equal((await h.api.sendPersistenceCommand({ ...value, kind: "set_subtask_status" }, seed.owner)).status, "unknown");
});
