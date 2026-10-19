import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { command } from "./contract-cases.mjs";

export const capabilities = {
  syntheticOnly: true, productionTarget: false, realImplementation: true, renderedUi: false,
  scheduling: "single-connection-deterministic",
  supportedCases: ["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T11", "T16", "T23", "T24"],
};

export async function createHarness(seed) {
  assert.ok(process.env.PGLITE_MODULE_PATH, "PGLITE_MODULE_PATH is required; no network database fallback");
  const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE_PATH)).href);
  const db = new PGlite();
  try {
    await db.exec(`
      create role authenticated; create role anon;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      grant usage on schema auth,public to authenticated;
    `);
    await db.exec(await readFile("supabase/schema.sql", "utf8"));
    for (const id of [seed.owner, seed.recipient, seed.outsider]) await db.query("insert into auth.users values($1)", [id]);
    for (const task of seed.tasks) await db.query(`
      insert into public.tasks(id,user_id,prefix,task_number,title,notes,category,priority,status,due_at,subtasks)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [task.id, seed.owner, task.prefix, task.number, task.title, task.notes, task.category, task.priority, task.status,
      `${task.dueDate}T12:00:00Z`, JSON.stringify(task.subtasks)]);
    const migration = await readFile("supabase/staged/persistence-foundation-v1.sql", "utf8");
    await db.exec(migration);
    assert.ok((await db.query("select enabled,read_only from persistence_v1.accounts")).rows.every((row) => !row.enabled && row.read_only));
    await db.query("update persistence_v1.accounts set enabled=true,read_only=false where user_id=$1", [seed.owner]);
    for (const prefix of ["P", "W"]) await db.query(`insert into public.task_taxonomy_items(user_id,item_type,prefix,name)
      values($1,'topic',$2,'Synthetic topic')`, [seed.owner, prefix]);

    let tail = Promise.resolve(), nextFault = null, transportInstalled = false, collaborationInstalled = false, lastShareId;
    const serialize = (fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    };
    const as = async (actor) => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor ?? ""]);
      const email = actor === seed.owner ? "owner@example.invalid" : actor === seed.recipient ? "recipient@example.invalid" : "outsider@example.invalid";
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: actor, email: actor ? email : "" })]);
      await db.exec("set role authenticated");
    };
    const admin = async () => { await db.exec("reset role"); };
    const h = {
      capabilities,
      async send(actor, value) {
        return serialize(async () => {
          const fault = nextFault;
          nextFault = null;
          let inTransaction = false, trigger = false;
          try {
            await admin();
            if (fault && ["receipt_insert_failure", "deadlock"].includes(fault.reason)) {
              assert.equal(fault.point, "before_commit");
              await db.exec(`create or replace function persistence_v1.synthetic_receipt_fault() returns trigger
                language plpgsql as $$ begin raise exception 'Synthetic receipt fault' using errcode='${fault.reason === "deadlock" ? "40P01" : "P0001"}'; end $$;
                create trigger synthetic_receipt_fault before insert on persistence_v1.receipts
                for each row execute function persistence_v1.synthetic_receipt_fault();`);
              trigger = true;
            }
            await db.exec("begin");
            inTransaction = true;
            await as(actor);
            const sql = transportInstalled ? "select public.persistence_command_v1($1::jsonb) as result" : "select persistence_v1.apply_task_command($1::jsonb) as result";
            const result = (await db.query(sql, [JSON.stringify(value)])).rows[0].result;
            if (fault?.point === "before_commit" && fault.reason === "lose_response") {
              await db.exec("rollback"); inTransaction = false;
              throw Object.assign(new Error("Synthetic response lost before COMMIT"), { code: "SYNTHETIC_TRANSPORT_TIMEOUT" });
            }
            await db.exec("commit"); inTransaction = false;
            if (fault?.point === "after_commit" && fault.reason === "lose_response") {
              throw Object.assign(new Error("Synthetic response lost after COMMIT"), { code: "SYNTHETIC_TRANSPORT_TIMEOUT" });
            }
            return result;
          } catch (error) {
            if (inTransaction) await db.exec("rollback");
            if (trigger && ["P0001", "40P01"].includes(error.code)) {
              throw Object.assign(new Error("Injected transaction abort", { cause: error }), { code: "SYNTHETIC_TRANSACTION_ABORT" });
            }
            throw error;
          } finally {
            await admin();
            if (trigger) await db.exec("drop trigger synthetic_receipt_fault on persistence_v1.receipts; drop function persistence_v1.synthetic_receipt_fault()");
          }
        });
      },
      async read(actor, id) {
        return serialize(async () => {
          try { await as(actor); return (await db.query("select persistence_v1.read_task($1) as task", [id])).rows[0].task; }
          finally { await admin(); }
        });
      },
      race(requests) {
        // Concurrent callers, serialized by the embedded single connection, NOT multi-session lock proof.
        return Promise.all(requests.map(({ actor, command }) => h.send(actor, command)));
      },
      async inspect() {
        return serialize(async () => {
          await admin();
          const accounts = (await db.query("select user_id,enabled,read_only,write_epoch::text,change_seq::text from persistence_v1.accounts order by user_id")).rows;
          const tasks = (await db.query("select to_jsonb(t) as task from public.tasks t order by id")).rows.map((row) => row.task);
          const receipts = (await db.query("select actor_id,operation_id as \"operationId\",payload_hash,target_id,result from persistence_v1.receipts order by actor_id,operation_id")).rows;
          const counters = Object.fromEntries((await db.query("select prefix,high_water::text from persistence_v1.counters where user_id=$1 order by prefix", [seed.owner])).rows.map((row) => [row.prefix, row.high_water]));
          const result = { tasks, receipts, counters, accounts, writeEpoch: accounts.find((row) => row.user_id === seed.owner).write_epoch };
          if (collaborationInstalled) {
            result.proposalExecutions = (await db.query('select message_id as "proposalId",operation_id,result from persistence_v1.proposal_executions order by message_id')).rows;
            result.shares = (await db.query("select to_jsonb(s) as item from public.task_shares s order by id")).rows.map((row) => row.item);
            result.assignments = (await db.query("select to_jsonb(s) as item from public.task_subtask_assignments s order by id")).rows.map((row) => row.item);
            result.messages = (await db.query("select to_jsonb(s) as item from public.assistant_messages s order by id")).rows.map((row) => row.item);
            result.proposals = (await db.query("select to_jsonb(s) as item from persistence_v1.proposals s order by message_id")).rows.map((row) => row.item);
          }
          return result;
        });
      },
      async fault(point, reason) {
        assert.ok(["before_commit", "after_commit"].includes(point));
        assert.ok(["lose_response", "receipt_insert_failure", "deadlock"].includes(reason));
        nextFault = { point, reason };
      },
      async fixture(name, payload = {}) {
        if (collaborationInstalled && name === "accepted_assignment") {
          let current = await h.read(seed.owner, payload.taskId);
          const invite = await h.send(seed.owner, command(current, { kind: "invite_share", patch: undefined, email: "recipient@example.invalid", role: "contributor" }));
          assert.equal(invite.status, "committed"); lastShareId = invite.shareId;
          const accept = await h.send(seed.recipient, command(invite.task, { kind: "accept_share", patch: undefined, shareId: lastShareId }));
          assert.equal(accept.status, "committed");
          current = await h.read(seed.owner, payload.taskId);
          assert.equal((await h.send(seed.owner, command(current, { kind: "assign_subtask", patch: undefined, shareId: lastShareId, subtaskId: payload.subtaskId }))).status, "committed");
          return lastShareId;
        }
        if (collaborationInstalled && name === "revoke_access") {
          const current = await h.read(seed.owner, payload.taskId);
          const result = await h.send(seed.owner, command(current, { kind: "revoke_share", patch: undefined, shareId: lastShareId }));
          assert.equal(result.status, "committed"); return result;
        }
        if (collaborationInstalled && name === "proposal") {
          const thread = (await h.admin("insert into public.assistant_threads(user_id,title) values($1,'Synthetic proposal thread') returning id", [seed.owner])).rows[0].id;
          const message = (await h.admin(`insert into public.assistant_messages(thread_id,user_id,role,content,proposed_action,action_status,persistence_epoch)
            values($1,$2,'assistant','Synthetic proposal',$3::jsonb,'proposed',1) returning id`, [thread, seed.owner, JSON.stringify(payload.action)])).rows[0].id;
          const current = await h.read(seed.owner, payload.taskId);
          const prepared = await h.send(seed.owner, command(current, { kind: "prepare_ai_proposal", patch: undefined, messageId: message,
            ...(payload.action.type === "create_task" ? { targetTaskUuid: undefined, expectedRevision: undefined } : {}) }));
          assert.equal(prepared.status, "prepared"); return prepared.proposalId;
        }
        assert.equal(name, "remove_highest_task_and_step");
        const current = await h.read(seed.owner, seed.tasks[0].id);
        assert.equal((await h.send(seed.owner, command(current, { kind: "remove_subtask", patch: undefined, subtaskId: "step-1-1" }))).status, "committed");
        return serialize(async () => {
          await admin();
          await db.query("delete from public.tasks where id=$1", [seed.tasks[1].id]);
        });
      },
      admin: (sql, params = []) => serialize(async () => { await admin(); return db.query(sql, params); }),
      asActor: (actor, sql, params = []) => serialize(async () => {
        try { await as(actor); return await db.query(sql, params); } finally { await admin(); }
      }),
      reapply: () => serialize(async () => { await admin(); await db.exec(migration); }),
      reapplyCollaboration: () => serialize(async () => {
        await admin();
        await db.exec(await readFile("supabase/staged/persistence-collaboration-v1.sql", "utf8"));
      }),
      stageTransport: () => serialize(async () => {
        await admin();
        await db.exec(await readFile("supabase/staged/persistence-transport-v1.sql", "utf8"));
        transportInstalled = true;
      }),
      stageCollaboration: () => serialize(async () => {
        await admin();
        await db.exec(`create role service_role bypassrls;
          alter table auth.users add column email text;
          create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;`);
        for (const [id, email] of [[seed.owner, "owner@example.invalid"], [seed.recipient, "recipient@example.invalid"], [seed.outsider, "outsider@example.invalid"]]) await db.query("update auth.users set email=$2 where id=$1", [id, email]);
        for (const file of ["add-task-sharing-foundation.sql", "enable-shared-task-reads.sql", "extend-task-sharing-lifecycle.sql",
          "add-shared-subtask-assignments.sql", "harden-task-share-snapshot-access.sql", "add-assistant-chat.sql", "staged/persistence-collaboration-v1.sql"]) {
          await db.exec(await readFile(`supabase/${file}`, "utf8"));
        }
        collaborationInstalled = true;
      }),
      page: (actor, { limit = 100, cursor = null } = {}) => serialize(async () => {
        assert.ok(transportInstalled);
        try {
          await as(actor);
          return (await db.query("select public.persistence_page_v1($1,$2::jsonb) as result", [limit, cursor === null ? null : JSON.stringify(cursor)])).rows[0].result;
        } finally { await admin(); }
      }),
      receipt: (actor, operationId) => serialize(async () => {
        assert.ok(transportInstalled);
        try {
          await as(actor);
          return (await db.query("select public.persistence_receipt_v1($1) as result", [operationId])).rows[0].result;
        } finally { await admin(); }
      }),
      async close() { await tail; await db.close(); },
    };
    return h;
  } catch (error) { await db.close(); throw error; }
}
