import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./foundation-adapter.mjs";
import { command, syntheticSeed as seed } from "./contract-cases.mjs";

const check = (title, run) => test(title, { skip: !process.env.PGLITE_MODULE_PATH && "Local PGlite path required" }, async () => {
  const h = await createHarness(structuredClone(seed));
  try { await run(h); } finally { await h.close(); }
});
const current = (h) => h.read(seed.owner, seed.tasks[0].id);
const create = () => command(undefined, { kind: "create_task", targetTaskUuid: undefined, expectedRevision: undefined,
  patch: { prefix: "P", title: "Synthetic creation", category: "Synthetic topic" } });

check("F01: staged activation and maintenance gates fail closed", async (h) => {
  const initial = await h.inspect();
  assert.ok(initial.accounts.filter((row) => row.user_id !== seed.owner).every((row) => !row.enabled && row.read_only));
  await h.admin("update persistence_v1.accounts set enabled=false where user_id=$1", [seed.owner]);
  assert.equal((await h.send(seed.owner, command())).status, "client_upgrade_required");
  await h.admin("update persistence_v1.accounts set enabled=true,read_only=true where user_id=$1", [seed.owner]);
  assert.equal((await h.send(seed.owner, command())).status, "account_read_only");
  assert.deepEqual((await h.inspect()).tasks, initial.tasks);
  assert.equal((await h.inspect()).receipts.length, 0);
});
check("F02: malformed, null, unknown and oversized fields fail before any mutation", async (h) => {
  const before = await h.inspect();
  for (const value of [null, [], {}, command(undefined, { patch: { title: null } }),
    command(undefined, { patch: { priority: null } }), command(undefined, { patch: { dueDate: "2026-02-30" } }),
    command(undefined, { patch: { dueDate: "not-a-date" } }), command(undefined, { patch: { notes: "x".repeat(66000) } }),
    command(undefined, { expectedRevision: 1 }), command(undefined, { expectedRevision: "9223372036854775808" }),
    command(undefined, { operationId: "invalid" }), command(undefined, { actor: seed.outsider }),
    command(undefined, { kind: "set_task_status", patch: undefined, status: null }),
    command(undefined, { kind: "set_owner_focus", patch: undefined, focused: "false" }),
    createWithNullPrefix()]) {
    assert.ok(["validation_failed", "client_upgrade_required"].includes((await h.send(seed.owner, value)).status));
  }
  assert.deepEqual(await h.inspect(), before);
});
function createWithNullPrefix() { const value = create(); value.patch.prefix = null; return value; }

check("F03: auth, owner scope, private tables and helpers cannot be bypassed", async (h) => {
  assert.equal(await h.read(seed.outsider, seed.tasks[0].id), null);
  assert.equal(await h.read(null, seed.tasks[0].id), null);
  assert.equal((await h.send(null, command())).status, "not_found_or_forbidden");
  await h.admin("update persistence_v1.accounts set enabled=true,read_only=false where user_id=$1", [seed.outsider]);
  assert.equal((await h.send(seed.outsider, command())).status, "not_found_or_forbidden");
  await assert.rejects(h.asActor(seed.owner, "select * from persistence_v1.receipts"), /permission denied/);
  const grants = (await h.admin(`select has_schema_privilege('anon','persistence_v1','usage') as anon_usage,
    has_function_privilege('authenticated','persistence_v1.valid_patch(jsonb,text[])','execute') as helper`)).rows[0];
  assert.deepEqual(grants, { anon_usage: false, helper: false });
});
check("F04: no-op keeps revision/change sequence and replay hash ignores object key order", async (h) => {
  const task = await current(h), value = command(task, { patch: { title: task.title } });
  const before = await h.inspect();
  const reply = await h.send(seed.owner, value);
  assert.equal(reply.status, "committed");
  assert.equal(reply.revision, task.revision);
  assert.equal((await h.inspect()).accounts.find((row) => row.user_id === seed.owner).change_seq,
    before.accounts.find((row) => row.user_id === seed.owner).change_seq);
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.equal((await h.send(seed.owner, reordered)).status, "committed");
  assert.equal((await h.inspect()).receipts.length, 1);
});
check("F05: step IDs and high-water survive removal; replacement arrays are forbidden", async (h) => {
  const value = command(await current(h), { kind: "add_subtask", patch: { title: "Synthetic second step" } });
  let reply = await h.send(seed.owner, value);
  assert.equal(reply.status, "committed");
  const newStep = reply.task.subtasks[1];
  assert.notEqual(newStep.id, "step-1-1");
  reply = await h.send(seed.owner, command(reply.task, { kind: "remove_subtask", patch: undefined, subtaskId: newStep.id }));
  reply = await h.send(seed.owner, command(reply.task, { kind: "add_subtask", patch: { title: "Synthetic third step" } }));
  assert.equal(reply.task.subtasks.at(-1).number, 3);
  assert.equal(reply.task.subtasks[0].id, "step-1-1");
  assert.equal((await h.send(seed.owner, command(reply.task, { patch: { subtasks: [] } }))).status, "validation_failed");
});
check("F06: receipt failure rolls back task allocation and allows the identical retry", async (h) => {
  const before = await h.inspect(), value = create();
  await h.fault("before_commit", "receipt_insert_failure");
  await assert.rejects(h.send(seed.owner, value), { code: "SYNTHETIC_TRANSACTION_ABORT" });
  assert.deepEqual(await h.inspect(), before);
  const result = await h.send(seed.owner, value);
  assert.equal(result.status, "committed");
  assert.equal(result.task.number, 3);
});
check("F07: reapplying staged bootstrap never lowers allocated floors or revisions", async (h) => {
  await h.admin("update persistence_v1.counters set high_water=100 where user_id=$1 and prefix='P'", [seed.owner]);
  await h.send(seed.owner, command());
  const before = await h.inspect();
  await h.reapply();
  assert.deepEqual(await h.inspect(), before);
  assert.equal((await h.send(seed.owner, create())).task.number, 101);
});
check("F08: epoch change rejects new stale writes without re-executing old receipts", async (h) => {
  const value = command();
  await h.send(seed.owner, value);
  await h.admin("update persistence_v1.accounts set write_epoch=2 where user_id=$1", [seed.owner]);
  const before = await h.inspect();
  assert.equal((await h.send(seed.owner, command())).status, "stale_epoch");
  const replay = await h.send(seed.owner, value);
  assert.equal(replay.status, "committed");
  assert.equal(replay.writeEpoch, "1");
  assert.equal(replay.task.writeEpoch, "2");
  assert.deepEqual(await h.inspect(), before);
});

check("F09: bigint revisions remain exact and exhausted integer counters roll back", async (h) => {
  await h.admin("update public.tasks set revision=9007199254740993 where id=$1", [seed.tasks[0].id]);
  let task = await current(h);
  assert.equal(task.revision, "9007199254740993");
  const result = await h.send(seed.owner, command(task));
  assert.equal(result.revision, "9007199254740994");
  await h.admin("update persistence_v1.counters set high_water=2147483647 where user_id=$1 and prefix='P'", [seed.owner]);
  const before = await h.inspect();
  await assert.rejects(h.send(seed.owner, create()), /counter unavailable or exhausted/);
  assert.deepEqual(await h.inspect(), before);
  task = await current(h);
  assert.equal(task.revision, "9007199254740994");
});

check("F10: durable conflict receipt cannot become a success after the target changes again", async (h) => {
  const first = command();
  const success = await h.send(seed.owner, first);
  const stale = command(undefined, { patch: { notes: "Synthetic stale intent" } });
  assert.equal((await h.send(seed.owner, stale)).status, "conflict");
  await h.send(seed.owner, command(success.task, { patch: { title: "Synthetic newer title" } }));
  const before = await h.inspect();
  const replay = await h.send(seed.owner, stale);
  assert.equal(replay.status, "conflict");
  assert.equal(replay.task.revision, "3");
  assert.equal(replay.task.notes, "Synthetic note");
  assert.deepEqual(await h.inspect(), before);
});

check("F11: a known taxonomy rejection cannot become a late unapproved success", async (h) => {
  const value = create();
  value.patch.category = "Synthetic missing topic";
  assert.equal((await h.send(seed.owner, value)).status, "validation_failed");
  await h.admin("insert into public.task_taxonomy_items(user_id,item_type,prefix,name) values($1,'topic','P',$2)", [seed.owner, value.patch.category]);
  assert.equal((await h.send(seed.owner, value)).status, "validation_failed");
  assert.equal((await h.inspect()).tasks.length, 2);
  const fresh = { ...value, operationId: create().operationId };
  assert.equal((await h.send(seed.owner, fresh)).status, "committed");
});
