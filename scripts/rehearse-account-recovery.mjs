import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Input arrives on stdin after local decryption. No network or Production connection.
const [enginePath, reportPath] = process.argv.slice(2);
if (!enginePath || !reportPath) throw new Error("Usage: node rehearse-account-recovery.mjs <PGlite index.js> <private report path> < snapshot.json");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
const snapshot = JSON.parse(raw);
assert.equal(snapshot.format, "task-tracker-account-recovery");
assert.equal(snapshot.version, 1);
assert.match(snapshot.owner_user_id, /^[0-9a-f-]{36}$/i);
assert.ok(Number.isFinite(Date.parse(snapshot.captured_at)));
const tables = ["tasks", "task_taxonomy_items", "user_settings", "task_shares", "task_subtask_assignments", "assistant_threads", "assistant_messages", "assistant_actions", "notification_receipts", "user_devices"];
const ownerTables = new Set(["task_shares", "task_subtask_assignments"]);
const primaryKeys = { user_settings: ["user_id"], notification_receipts: ["user_id", "event_key", "kind"] };
for (const table of tables) {
  const rows = snapshot.data[table];
  assert.ok(Array.isArray(rows), `Missing collection ${table}`);
  assert.ok(rows.every(row => row[ownerTables.has(table) ? "owner_user_id" : "user_id"] === snapshot.owner_user_id), `Ownership mismatch: ${table}`);
  const keys = primaryKeys[table] ?? ["id"];
  assert.equal(new Set(rows.map(row => JSON.stringify(keys.map(k => row[k])))).size, rows.length, `Duplicate primary key: ${table}`);
}
assert.equal(new Set(snapshot.data.tasks.map(t => `${t.prefix}:${t.task_number}`)).size, snapshot.data.tasks.length);
for (const prefix of ["P", "W"]) assert.ok(snapshot.task_number_floor[prefix] >= Math.max(0, ...snapshot.data.tasks.filter(t => t.prefix === prefix).map(t => t.task_number)));
const { PGlite } = await import(pathToFileURL(resolve(enginePath)).href);
const db = new PGlite();
const checks = [];
const started = Date.now();
let stage = "schema setup";
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth, public to anon, authenticated, service_role;`);
  for (const file of ["schema.sql", "add-task-sharing-foundation.sql", "enable-shared-task-reads.sql", "extend-task-sharing-lifecycle.sql", "add-shared-subtask-assignments.sql", "add-assistant-chat.sql", "add-assistant-archive-continuation.sql", "harden-assistant-rls-policies.sql", "add-notification-receipts.sql", "add-google-drive-backups.sql", "harden-task-share-snapshot-access.sql"]) {
    await db.exec(await readFile(`supabase/${file}`, "utf8"));
  }
  // Fail closed on column drift, rather than silently dropping unknown fields.
  for (const table of tables) {
    stage = `schema comparison: ${table}`;
    const columns = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1", [table])).rows.map(r => r.column_name).sort();
    assert.deepEqual(columns, [...snapshot.live_columns[table]].sort(), `Live schema drift: ${table}`);
    for (const row of snapshot.data[table]) assert.ok(Object.keys(row).every(key => columns.includes(key)), `Unknown row field: ${table}`);
  }
  checks.push("live column sets match the isolated schema; account ownership, primary keys and P/W uniqueness valid");
  const referencedUsers = new Set([snapshot.owner_user_id]);
  for (const table of tables) for (const row of snapshot.data[table]) for (const key of ["user_id", "owner_user_id", "shared_with_user_id", "ended_by_user_id", "assignee_user_id"]) {
    if (row[key]) referencedUsers.add(row[key]);
  }
  for (const user of referencedUsers) await db.query("insert into auth.users(id) values ($1)", [user]);
  const insertRows = async (table, rows) => {
    stage = `isolated restore: ${table}`;
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);
    assert.ok(rows.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...columns].sort())), `Inconsistent columns: ${table}`);
    const keys = primaryKeys[table] ?? ["id"];
    const quoted = columns.map(c => `"${c}"`).join(",");
    const updates = columns.filter(c => !keys.includes(c)).map(c => `"${c}"=excluded."${c}"`).join(",");
    await db.query(`insert into public."${table}" (${quoted}) select ${quoted} from jsonb_populate_recordset(null::public."${table}",$1::jsonb) on conflict (${keys.map(c => `"${c}"`).join(",")}) ${updates ? `do update set ${updates}` : "do nothing"}`, [JSON.stringify(rows)]);
  };
  const restore = async data => {
    await db.exec("begin");
    try { for (const table of tables) await insertRows(table, data[table]); await db.exec("commit"); }
    catch (error) { await db.exec("rollback"); throw error; }
  };
  const compare = async () => {
    for (const table of tables) {
      stage = `field comparison: ${table}`;
      const count = (await db.query(`select count(*)::int as n from public."${table}"`)).rows[0].n;
      assert.equal(count, snapshot.data[table].length, `Row count: ${table}`);
      const diff = await db.query(`select count(*)::int as n from ((select to_jsonb(t) as row from public."${table}" t except select to_jsonb(s) from jsonb_populate_recordset(null::public."${table}",$1::jsonb) s) union all (select to_jsonb(s) from jsonb_populate_recordset(null::public."${table}",$1::jsonb) s except select to_jsonb(t) from public."${table}" t)) differences`, [JSON.stringify(snapshot.data[table])]);
      assert.equal(diff.rows[0].n, 0, `Exact field comparison: ${table}`);
    }
  };
  await restore(snapshot.data);
  await compare();
  checks.push("all ten account collections restored with exact typed field equality, including history, sharing records, allocations and conversations");
  await restore(snapshot.data);
  await compare();
  checks.push("repeated isolated restore does not duplicate records or change P/W or step identifiers");
  const bad = structuredClone(snapshot.data);
  if (bad.tasks.length) bad.tasks[0].title = "Rollback verification only";
  bad.task_taxonomy_items.push({ id: randomUUID(), user_id: snapshot.owner_user_id, item_type: "topic", prefix: "P", name: "", created_at: snapshot.captured_at, updated_at: snapshot.captured_at });
  await assert.rejects(restore(bad));
  await compare();
  checks.push("constraint failure rolls back earlier writes; no partial task or taxonomy recovery");
  await db.exec("grant select on all tables in schema public to anon, authenticated");
  await db.exec("set role anon");
  assert.equal((await db.query("select count(*)::int as n from public.tasks")).rows[0].n, 0);
  await assert.rejects(db.query("select public.task_share_snapshot($1)", [randomUUID()]), /permission denied/);
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [randomUUID()]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ email: "unrelated-recovery-test@example.invalid" })]);
  for (const table of ["tasks", "task_shares", "task_subtask_assignments", "assistant_messages", "assistant_threads"]) assert.equal((await db.query(`select count(*)::int as n from public."${table}"`)).rows[0].n, 0);
  checks.push("anonymous and unrelated authenticated identities cannot read restored tasks/shares/conversations; SEC01 helper remains denied");
  await db.exec("reset role");
  const report = {
    verifiedAt: new Date().toISOString(), capturedAt: snapshot.captured_at,
    format: snapshot.format, version: snapshot.version,
    snapshotSha256: createHash("sha256").update(raw).digest("hex"),
    counts: Object.fromEntries(tables.map(t => [t, snapshot.data[t].length])),
    taskNumberFloor: snapshot.task_number_floor,
    rehearsalDurationSeconds: Math.round((Date.now() - started) / 1000),
    checks,
    limitations: ["In-memory local rehearsal only; no Production restore", "Auth users are identity-only stubs, not recovered accounts or login credentials", "Incoming shares are references only and cannot re-establish another owner's access", "OAuth tokens, secrets, Drive files, browser-only drafts and platform configuration excluded", "Not a full database disaster-recovery dump or a scheduled backup service", "Current row maxima are a lower bound, not proof of every historically consumed task number", "Cloud writes since capture require a fresh snapshot before migration"],
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`FAIL: ${stage}; ${error.name}; code=${error.code ?? "none"}. Record contents and database parameters are not logged.`);
  process.exitCode = 1;
} finally { await db.close(); }
