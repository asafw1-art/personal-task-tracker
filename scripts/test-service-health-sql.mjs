import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Requires an existing local PGlite installation; no network or Production access.
if (!process.argv[2]) throw new Error("Pass the path to PGlite dist/index.js");
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select current_setting('request.jwt.claims', true)::jsonb $$;
    grant usage on schema auth, public to anon, authenticated, service_role;`);
  const sql = await readFile("supabase/add-service-health.sql", "utf8");
  await db.exec(sql);
  await db.exec(sql);
  const record = (state, reason, time) => db.query("select public.record_service_health('gemini', $1, $2, 'request', $3)", [state, reason, time]);
  await db.exec("set role service_role");
  await record("error", "timeout", "2026-09-23T10:00:00Z");
  const first = (await db.query("select * from public.service_health")).rows[0];
  await record("error", "timeout", "2026-09-23T10:01:00Z");
  assert.equal((await db.query("select incident_id from public.service_health")).rows[0].incident_id, first.incident_id);
  await record("healthy", "ok", "2026-09-23T10:02:00Z");
  await record("error", "timeout", "2026-09-23T10:00:30Z");
  const recovered = (await db.query("select * from public.service_health")).rows[0];
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.incident_id, null);
  assert.ok(recovered.last_success_at);
  await record("error", "timeout", "2026-09-23T10:03:00Z");
  assert.notEqual((await db.query("select incident_id from public.service_health")).rows[0].incident_id, first.incident_id);
  await db.exec("reset role; set role authenticated;");
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email: "other@example.invalid" })]);
  assert.equal((await db.query("select * from public.service_health")).rows.length, 0);
  await assert.rejects(record("healthy", "ok", "2026-09-23T11:00:00Z"), /permission denied/);
  await assert.rejects(db.query("delete from public.service_health"), /permission denied/);
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email: "asafw1@gmail.com" })]);
  assert.equal((await db.query("select * from public.service_health")).rows.length, 1);
  await assert.rejects(record("healthy", "ok", "2026-09-23T11:00:00Z"), /permission denied/);
  await db.exec("reset role; set role anon");
  await assert.rejects(db.query("select * from public.service_health"), /permission denied/);
  console.log("PASS: repeatable migration, RLS admin-only read, server-only write, incident dedup/recovery, out-of-order observations.");
} finally { await db.close(); }
