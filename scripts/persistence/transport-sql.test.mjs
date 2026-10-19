import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./transport-adapter.mjs";
import { command, syntheticSeed as seed } from "./contract-cases.mjs";
import { loadIsolatedModule } from "./fixtures.mjs";

const check = (title, run) => test(title, { skip: !process.env.PGLITE_MODULE_PATH && "Local PGlite required" }, async () => {
  const h = await createHarness(structuredClone(seed));
  try { await run(h); } finally { await h.close(); }
});
check("P01: complete pagination returns each owned UUID once and marks partial pages", async (h) => {
  await h.admin("insert into public.tasks(user_id,prefix,task_number,title) values($1,'P',1,'Synthetic outsider task')", [seed.outsider]);
  const first = await h.page(seed.owner, { limit: 1 });
  assert.equal(first.status, "ok"); assert.equal(first.complete, false);
  assert.equal(first.tasks.length, 1); assert.ok(first.cursor);
  const second = await h.page(seed.owner, { limit: 1, cursor: first.cursor });
  assert.equal(second.complete, true); assert.equal(second.cursor, null);
  assert.deepEqual([...first.tasks, ...second.tasks].map((task) => task.id).sort(), seed.tasks.map((task) => task.id).sort());
  assert.equal(typeof first.changeSeq, "string"); assert.equal(typeof first.writeEpoch, "string");
});
check("P02: receipt lookup distinguishes unknown, committed and no-longer-accessible", async (h) => {
  const value = command();
  assert.equal((await h.receipt(seed.owner, value.operationId)).status, "unknown");
  assert.equal((await h.send(seed.owner, value)).status, "committed");
  assert.equal((await h.receipt(seed.owner, value.operationId)).task.title, "Synthetic edit");
  await h.admin("update persistence_v1.accounts set enabled=true where user_id=$1", [seed.outsider]);
  const other = await h.receipt(seed.outsider, value.operationId);
  assert.equal(other.status, "unknown"); assert.equal(other.task, undefined);
  await h.admin("delete from public.tasks where id=$1", [seed.tasks[0].id]);
  const removed = await h.receipt(seed.owner, value.operationId);
  assert.equal(removed.status, "not_found_or_forbidden"); assert.equal(removed.task, undefined);
});
check("P03: page cursors reject epoch changes and foreign owner binding", async (h) => {
  const first = await h.page(seed.owner, { limit: 1 });
  const invalid = await h.page(seed.owner, { limit: 1, cursor: { ...first.cursor, owner: seed.outsider } });
  assert.equal(invalid.status, "validation_failed");
  await h.admin("update persistence_v1.accounts set write_epoch=2 where user_id=$1", [seed.owner]);
  assert.equal((await h.page(seed.owner, { cursor: first.cursor })).status, "restart_required");
  assert.equal((await h.inspect()).tasks.length, 2);
});
check("P04: malformed cursor and limit inputs are rejected without a write", async (h) => {
  const before = await h.inspect();
  for (const options of [{ limit: 0 }, { limit: 201 }, { cursor: [] }, { cursor: "bad" }, { cursor: {} },
    { cursor: { owner: seed.owner, afterId: "bad", changeSeq: "0", writeEpoch: "1" } },
    { cursor: { owner: seed.owner, afterId: seed.tasks[0].id, changeSeq: "9223372036854775808", writeEpoch: "1" } }]) {
    assert.equal((await h.page(seed.owner, options)).status, "validation_failed");
  }
  assert.deepEqual(await h.inspect(), before);
});
check("P05: public wrappers require auth and cannot impersonate another owner", async (h) => {
  const grants = (await h.admin(`select
    has_function_privilege('anon','public.persistence_command_v1(jsonb)','execute') as anon_command,
    has_function_privilege('anon','public.persistence_page_v1(integer,jsonb)','execute') as anon_page,
    has_function_privilege('anon','public.persistence_receipt_v1(uuid)','execute') as anon_receipt`)).rows[0];
  assert.deepEqual(grants, { anon_command: false, anon_page: false, anon_receipt: false });
  assert.equal((await h.page(null)).status, "not_found_or_forbidden");
  assert.equal((await h.send(seed.owner, command(undefined, { userId: seed.outsider }))).status, "validation_failed");
  const id = "20000000-0000-4000-8000-000000000099";
  await h.admin("insert into public.tasks(id,user_id,prefix,task_number,title) values($1,$2,'P',1,'Synthetic protected title')", [id, seed.outsider]);
  const result = await h.send(seed.owner, command(undefined, { targetTaskUuid: id }));
  assert.equal(result.status, "not_found_or_forbidden"); assert.equal(result.task, undefined);
});
check("P06: reads and transport reinstall preserve state and maintenance still permits reads", async (h) => {
  const value = command(); await h.send(seed.owner, value);
  await h.admin("update persistence_v1.accounts set read_only=true where user_id=$1", [seed.owner]);
  const before = await h.inspect();
  assert.equal((await h.page(seed.owner)).status, "ok");
  assert.equal((await h.receipt(seed.owner, value.operationId)).status, "committed");
  assert.equal((await h.send(seed.owner, command())).status, "account_read_only");
  await h.stageTransport();
  assert.deepEqual(await h.inspect(), before);
});

check("E01: real client + HTTP handler + RPC SQL recover a lost ACK end-to-end", async (h) => {
  const previousFetch = globalThis.fetch;
  const names = ["PERSISTENCE_V1_ENABLED", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
  const previousEnv = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PERSISTENCE_V1_ENABLED = "true";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "synthetic-publishable";
    class AuthError extends Error { constructor() { super("Synthetic auth error"); this.status = 401; } }
    const server = loadIsolatedModule("src/lib/server/persistenceTransport.ts", {
      "@/lib/server/supabaseServer": { RequestAuthError: AuthError, verifyRequestUser: async (request) => {
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-token");
        return { id: seed.owner };
      } },
      "@supabase/supabase-js": { createClient: (_url, key, options) => {
        assert.equal(key, "synthetic-publishable");
        assert.equal(options.global.headers.Authorization, "Bearer synthetic-token");
        return { rpc: async (name, args) => {
          let result;
          if (name === "persistence_command_v1") result = await h.asActor(seed.owner,
            "select public.persistence_command_v1($1::jsonb) as result", [JSON.stringify(args.p_command)]);
          else if (name === "persistence_receipt_v1") result = await h.asActor(seed.owner,
            "select public.persistence_receipt_v1($1) as result", [args.p_operation_id]);
          else {
            assert.equal(name, "persistence_page_v1");
            result = await h.asActor(seed.owner, "select public.persistence_page_v1($1,$2::jsonb) as result",
              [args.p_limit, args.p_cursor === null ? null : JSON.stringify(args.p_cursor)]);
          }
          return { data: result.rows[0].result, error: null };
        } };
      } },
    });
    const route = loadIsolatedModule("src/app/api/persistence/route.ts", { "@/lib/server/persistenceTransport": server });
    const client = loadIsolatedModule("src/lib/persistenceTransport.ts", { "@/lib/supabase": { supabase: { auth: {
      getSession: async () => ({ data: { session: { user: { id: seed.owner }, access_token: "synthetic-token" } }, error: null }),
    } } } });
    const network = async (url, options) => route[options.method](new Request(`https://synthetic.invalid${url}`, options));
    globalThis.fetch = network;
    const initial = command();
    assert.equal((await client.sendPersistenceCommand(initial, seed.owner)).status, "committed");
    const page = await client.fetchPersistencePage(seed.owner, null, 1);
    assert.equal(page.status, "ok"); assert.equal(page.complete, false);
    const current = await h.read(seed.owner, seed.tasks[0].id);
    const next = command(current, { patch: { title: "Synthetic lost-ACK edit" } });
    let attempts = 0;
    globalThis.fetch = async (url, options) => { attempts++; await network(url, options); throw new Error("Synthetic reply lost after COMMIT"); };
    const unknown = await client.sendPersistenceCommand(next, seed.owner);
    assert.equal(unknown.status, "unknown"); assert.equal(unknown.operationId, next.operationId); assert.equal(attempts, 1);
    globalThis.fetch = network;
    assert.equal((await client.checkPersistenceOperation(next.operationId, seed.owner)).status, "committed");
    assert.equal((await client.sendPersistenceCommand(next, seed.owner)).revision, "3");
    assert.equal((await h.inspect()).receipts.length, 2);
    assert.equal((await h.read(seed.owner, seed.tasks[0].id)).title, "Synthetic lost-ACK edit");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
