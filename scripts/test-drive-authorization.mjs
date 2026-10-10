import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import ts from "typescript";

function load(path, imports = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

const health = load("src/lib/driveBackupHealth.ts");
const now = Date.parse("2026-10-10T12:00:00Z");
const fresh = new Date(now - 60_000).toISOString();
assert.equal(health.driveConnectionHealth({ status: "connected", lastError: null, lastSuccessAt: fresh }, now).healthy, true);
for (const date of [null, "bad-date", new Date(now - 86400000).toISOString()]) {
  const value = health.driveConnectionHealth({ status: "connected", lastError: null, lastSuccessAt: date }, now);
  assert.equal(value.backupOverdue, true);
  assert.equal(value.healthy, false);
}
assert.equal(health.driveConnectionHealth({ status: "error", lastError: "Bad Request", lastSuccessAt: fresh }, now).reconnectRequired, false);
assert.equal(health.driveConnectionHealth({ status: "error", lastError: health.driveTokenError("invalid_grant").message, lastSuccessAt: fresh }, now).reconnectRequired, true);
assert.equal(health.driveConnectionHealth({ status: "connected", lastError: health.driveTokenError("invalid_grant").message, lastSuccessAt: fresh }, now).reconnectRequired, false);
assert.equal(health.driveConnectionHealth({ status: "disconnected", lastError: null, lastSuccessAt: null }, now).backupOverdue, false);

const names = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DRIVE_TOKEN_ENCRYPTION_KEY"];
const originalEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
Object.assign(process.env, { GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "SYNTHETIC_SECRET", DRIVE_TOKEN_ENCRYPTION_KEY: "synthetic-encryption-key" });
let connection = {
  user_id: "synthetic-owner", google_email: "test@example.invalid", folder_id: "synthetic-folder",
  status: "connected", last_error: null, last_success_at: fresh, encrypted_refresh_token: null,
  timezone: "Asia/Jerusalem", onboarding_prompt_count: 0, remind_after: null,
};
const updates = [];
let result = { data: null, error: null };
function query(table) {
  const api = {
    select() { result = { data: table === "drive_backup_runs" ? [] : connection, error: null }; return api; },
    eq() { return api; }, is() { return api; }, order() { return api; }, limit() { return api; },
    update(value) { updates.push(value); connection = { ...connection, ...value }; result = { data: connection, error: null }; return api; },
    upsert(value) { connection = { ...connection, ...value }; result = { data: connection, error: null }; return api; },
    maybeSingle: async () => result, single: async () => result,
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return api;
}
const api = load("src/lib/server/driveBackup.ts", {
  "node:crypto": crypto,
  "@/lib/server/supabaseServer": { createSupabaseAdmin: () => ({ from: query }) },
  "@/lib/driveBackupHealth": health,
});
try {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.ok(init.signal);
    return Response.json({ error: "invalid_grant", error_description: "PRIVATE_PROVIDER_ECHO SYNTHETIC_SECRET" }, { status: 400 });
  };
  await assert.rejects(api.exchangeGoogleCode("synthetic-code", "https://example.invalid"), (error) => {
    assert.equal(error.code, "invalid_grant");
    assert.ok(!error.message.includes("PRIVATE_PROVIDER_ECHO"));
    assert.ok(!error.message.includes("SYNTHETIC_SECRET"));
    return true;
  });
  await api.saveGoogleConnection(connection.user_id, connection.google_email, "synthetic-refresh-token");
  assert.equal(connection.folder_id, "synthetic-folder");
  assert.ok(!connection.encrypted_refresh_token.includes("synthetic-refresh-token"));
  const storedToken = connection.encrypted_refresh_token;
  await assert.rejects(api.createBackupForConnection({ ...connection }, "manual"), { code: "invalid_grant" });
  assert.equal(connection.status, "error");
  assert.equal(connection.encrypted_refresh_token, storedToken);
  assert.equal((await api.driveBackupOverview(connection.user_id)).connection.reconnectRequired, true);
  const callCount = calls;
  await assert.rejects(api.createBackupForConnection({ ...connection }, "hourly"), { code: "invalid_grant" });
  assert.equal(calls, callCount, "Known invalid grant must not retry until reconnection");
  await api.saveGoogleConnection(connection.user_id, connection.google_email, "synthetic-new-token");
  assert.equal(connection.status, "connected");
  assert.equal(connection.last_error, null);
  assert.equal((await api.driveBackupOverview(connection.user_id)).connection.reconnectRequired, false);

  for (const code of ["invalid_client", "unauthorized_client", "temporarily_unavailable", "PRIVATE_UNKNOWN_CODE"]) {
    globalThis.fetch = async () => Response.json({ error: code, error_description: "PRIVATE_PROVIDER_ECHO" }, { status: 400 });
    await assert.rejects(api.exchangeGoogleCode("synthetic-code", "https://example.invalid"), (error) => {
      assert.equal(error.code, code === "PRIVATE_UNKNOWN_CODE" ? "unknown" : code);
      assert.ok(!error.message.includes("PRIVATE"));
      return true;
    });
  }
  for (const body of ["bad-json", "null", '{}', '{"access_token":" "}']) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(api.exchangeGoogleCode("synthetic-code", "https://example.invalid"), { code: "invalid_response" });
  }
  globalThis.fetch = async () => { throw new DOMException("PRIVATE_PROVIDER_ECHO", "TimeoutError"); };
  await assert.rejects(api.exchangeGoogleCode("synthetic-code", "https://example.invalid"), { code: "timeout" });
  globalThis.fetch = async () => { throw new Error("PRIVATE_PROVIDER_ECHO"); };
  await assert.rejects(api.exchangeGoogleCode("synthetic-code", "https://example.invalid"), { code: "network_error" });
  globalThis.fetch = async () => Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
  assert.equal((await api.exchangeGoogleCode("synthetic-code", "https://example.invalid")).access_token, "synthetic-access");
  console.log("PASS: OAuth classification/redaction, timeout, stale backup, invalid-grant persistence, retry suppression, encrypted token preservation and reconnection reset.");
} finally {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
}
