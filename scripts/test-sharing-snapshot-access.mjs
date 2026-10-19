import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Pass the existing PGlite dist/index.js path");
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const db = new PGlite();
const ids = {
  owner: "10000000-0000-4000-8000-000000000001",
  recipient: "10000000-0000-4000-8000-000000000002",
  outsider: "10000000-0000-4000-8000-000000000003",
  task1: "20000000-0000-4000-8000-000000000001",
  task2: "20000000-0000-4000-8000-000000000002",
  share1: "30000000-0000-4000-8000-000000000001",
  share2: "30000000-0000-4000-8000-000000000002",
};
async function actAs(role, user = "", email = "") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: user, email })]);
  await db.exec(`set role ${role}`);
}
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
  `);
  for (const file of ["schema.sql", "add-task-sharing-foundation.sql", "enable-shared-task-reads.sql", "extend-task-sharing-lifecycle.sql", "add-shared-subtask-assignments.sql"]) {
    await db.exec(await readFile(`supabase/${file}`, "utf8"));
  }
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public to anon, authenticated;
    grant execute on function public.task_share_snapshot(uuid) to anon, authenticated, service_role;
    grant execute on function public.revoke_task_share(uuid), public.leave_task_share(uuid) to anon;
  `);
  for (const [user, email] of [[ids.owner, "owner@example.invalid"], [ids.recipient, "recipient@example.invalid"], [ids.outsider, "outsider@example.invalid"]]) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [user, email]);
  }
  for (const [number, task, share] of [[1, ids.task1, ids.share1], [2, ids.task2, ids.share2]]) {
    const step = { id: `P${number}.1`, number: 1, title: "Synthetic step", status: "open" };
    await db.query("insert into tasks(id,user_id,prefix,task_number,title,notes,subtasks) values ($1,$2,'P',$3,'Synthetic task','Synthetic note',$4::jsonb)", [task, ids.owner, number, JSON.stringify([step])]);
    await db.query("insert into task_shares(id,task_id,owner_user_id,shared_with_user_id,shared_with_email,status) values ($1,$2,$3,$4,'recipient@example.invalid','accepted')", [share, task, ids.owner, ids.recipient]);
    await db.query("insert into task_subtask_assignments(task_id,subtask_id,subtask_number,share_id,owner_user_id,assignee_email) values ($1,$2,1,$3,$4,'recipient@example.invalid')", [task, step.id, share, ids.owner]);
  }
  const original = (await db.query("select pg_get_functiondef('public.task_share_snapshot(uuid)'::regprocedure) as definition")).rows[0].definition;
  await actAs("anon");
  assert.equal((await db.query("select public.task_share_snapshot($1) as snapshot", [ids.task1])).rows[0].snapshot.title, "Synthetic task");
  await actAs("postgres");
  const migration = await readFile("supabase/harden-task-share-snapshot-access.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await db.query("select pg_get_functiondef('public.task_share_snapshot(uuid)'::regprocedure) as definition")).rows[0].definition, original);
  for (const [role, user, email] of [["anon", "", ""], ["authenticated", ids.outsider, "outsider@example.invalid"], ["authenticated", ids.owner, "owner@example.invalid"]]) {
    await actAs(role, user, email);
    await assert.rejects(db.query("select public.task_share_snapshot($1)", [ids.task1]), /permission denied/);
  }
  await actAs("authenticated", ids.outsider, "outsider@example.invalid");
  await assert.rejects(db.query("select public.revoke_task_share($1)", [ids.share1]), /not found|cannot be revoked/i);
  await assert.rejects(db.query("select public.leave_task_share($1)", [ids.share2]), /not found|cannot be left/i);
  await actAs("anon");
  await assert.rejects(db.query("select public.leave_task_share($1)", [ids.share2]), /Authentication required/);
  await actAs("authenticated", ids.owner, "owner@example.invalid");
  const revoked = (await db.query("select * from public.revoke_task_share($1)", [ids.share1])).rows[0];
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.task_snapshot.notes, "Synthetic note");
  await actAs("authenticated", ids.recipient, "recipient@example.invalid");
  const left = (await db.query("select * from public.leave_task_share($1)", [ids.share2])).rows[0];
  assert.equal(left.status, "left");
  assert.equal(left.task_snapshot.subtasks[0].title, "Synthetic step");
  await actAs("postgres");
  assert.equal((await db.query("select count(*)::int as n from task_subtask_assignments where ended_at is not null and end_reason='share_ended'")).rows[0].n, 2);
  assert.equal((await db.query("select count(*)::int as n from tasks")).rows[0].n, 2);
  assert.equal((await db.query("select has_function_privilege('service_role','public.task_share_snapshot(uuid)','EXECUTE') as allowed")).rows[0].allowed, true);
  console.log("PASS: synthetic exposure reproduced; repeatable fix blocks anon, outsider and direct owner; authorized revoke/leave and assignment triggers preserved; helper body and task data unchanged.");
} finally { await db.close(); }
