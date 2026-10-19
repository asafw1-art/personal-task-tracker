import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { owner, outsider } from "./fixtures.mjs";

const modulePath = process.env.PGLITE_MODULE_PATH;
test("SQL / current repository schema, isolated PostgreSQL only", { skip: !modulePath && "Pass PGLITE_MODULE_PATH to run SQL evidence" }, async (t) => {
  const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
  const db = new PGlite();
  const id = "20000000-0000-4000-8000-000000000001";
  async function as(user) {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user.id]);
    await db.exec("set role authenticated");
  }
  try {
    await db.exec(`
      create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      grant usage on schema public, auth to authenticated;
    `);
    await db.exec(await readFile("supabase/schema.sql", "utf8"));
    await db.exec("grant select,insert,update,delete on all tables in schema public to authenticated");
    for (const user of [owner, outsider]) await db.query("insert into auth.users values ($1)", [user.id]);
    await db.query("insert into public.tasks(id,user_id,prefix,task_number,title) values ($1,$2,'P',1,'Synthetic original')", [id, owner.id]);

    await t.test("S01 baseline: RLS hides tasks and blocks outsider inserts/updates", async () => {
      await as(outsider);
      assert.equal((await db.query("select id from tasks")).rows.length, 0);
      assert.equal((await db.query("update tasks set title='Synthetic attack' where id=$1 returning id", [id])).rows.length, 0);
      await assert.rejects(db.query("insert into tasks(user_id,prefix,task_number,title) values ($1,'P',2,'Synthetic attack')", [owner.id]), /row-level security/);
    });
    await t.test("S02 / T15 risk: owner direct DML still bypasses the future command contract", async () => {
      await as(owner);
      assert.equal((await db.query("update tasks set title='Synthetic direct update' where id=$1 returning title", [id])).rows[0].title, "Synthetic direct update");
    });
    await t.test("S03 / T16 risk: owner can alter a committed display number today", async () => {
      await as(owner);
      assert.equal((await db.query("update tasks set task_number=19 where id=$1 returning task_number", [id])).rows[0].task_number, 19);
      await db.query("update tasks set task_number=1 where id=$1", [id]);
    });
    await t.test("S04 baseline: unique owner/prefix/number rejects duplicate plain INSERT", async () => {
      await as(owner);
      await assert.rejects(db.query("insert into tasks(user_id,prefix,task_number,title) values ($1,'P',1,'Synthetic collision')", [owner.id]), /duplicate key/);
      assert.equal((await db.query("select count(*)::integer as count from tasks")).rows[0].count, 1);
    });
    await t.test("S05 / T04 risk: actual ON CONFLICT update collapses two numbered creations", async () => {
      await as(owner);
      for (const title of ["Synthetic creation A", "Synthetic creation B"]) {
        await db.query(`insert into tasks(user_id,prefix,task_number,title) values ($1,'P',2,$2)
          on conflict(user_id,prefix,task_number) do update set title=excluded.title`, [owner.id, title]);
      }
      const result = (await db.query("select title from tasks where task_number=2")).rows;
      assert.deepEqual(result, [{ title: "Synthetic creation B" }]);
    });
    await t.test("S06 baseline: a real transaction constraint error rolls back the earlier write", async () => {
      await as(owner);
      const before = (await db.query("select title from tasks where id=$1", [id])).rows;
      await db.exec("begin");
      try {
        await db.query("update tasks set title='Synthetic uncommitted edit' where id=$1", [id]);
        await assert.rejects(db.query("insert into tasks(user_id,prefix,task_number,title) values ($1,'P',0,'Synthetic invalid')", [owner.id]), /check constraint/);
      } finally {
        await db.exec("rollback");
      }
      assert.deepEqual((await db.query("select title from tasks where id=$1", [id])).rows, before);
    });
  } finally {
    await db.close();
  }
});
