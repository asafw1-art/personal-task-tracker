import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./domains-adapter.mjs";
import { command, syntheticSeed as seed } from "./contract-cases.mjs";
const check = (name, run) => test(name, { skip: !process.env.PGLITE_MODULE_PATH && "PGlite required" }, async () => {
  const h = await createHarness(structuredClone(seed));
  try { await run(h); } finally { await h.close(); }
});
const domain = (kind, extra = {}) => command(undefined, { kind, targetTaskUuid: undefined, expectedRevision: undefined, patch: undefined, expectedDomainRevision: "1", ...extra });
const context = async (h, actor = seed.owner) => (await h.asActor(actor, "select public.persistence_context_v1() value")).rows[0].value;
const snapshot = async (h) => (await h.admin("select public.persistence_export_account_v1($1) value", [seed.owner])).rows[0].value;
check("D01: reads do not provision or write; settings have independent optimistic versions", async (h) => {
  const before = await snapshot(h);
  assert.equal((await context(h)).settingsRevision, "1");
  assert.deepEqual((await snapshot(h)).persistence, before.persistence);
  const value = domain("save_settings", { patch: { display_name: "Synthetic user" } });
  const result = await h.send(seed.owner, value);
  assert.equal(result.status, "committed"); assert.equal(result.revision, "2");
  assert.equal((await h.send(seed.owner, domain("save_settings", { patch: { theme: "dark" } }))).status, "conflict");
  assert.equal((await h.send(seed.owner, value)).revision, "2");
  assert.equal((await context(h)).settings.display_name, "Synthetic user");
  assert.equal((await h.read(seed.owner, seed.tasks[0].id)).revision, "1");
});
check("D02: unknown settings, invalid preferences and removed in-use taxonomy reject atomically", async (h) => {
  for (const patch of [{ user_id: seed.outsider }, { notification_preferences: [] }, { notification_preferences: { x: "true" } }, { analytics_preferences: { unknown: 1 } }, { theme: "unknown" }])
    assert.equal((await h.send(seed.owner, domain("save_settings", { patch }))).status, "validation_failed");
  assert.equal((await h.send(seed.owner, domain("replace_taxonomy", { taxonomy: [] }))).status, "validation_failed");
  assert.equal((await context(h)).taxonomyRevision, "1");
});
check("D03: known batch conflict rolls back earlier rows and receipts", async (h) => {
  const result = await h.send(seed.owner, domain("import", { expectedDomainRevision: undefined, items: [
    { kind: "patch_task", targetTaskUuid: seed.tasks[0].id, expectedRevision: "1", patch: { title: "Must roll back" } },
    { kind: "patch_task", targetTaskUuid: seed.tasks[1].id, expectedRevision: "99", patch: { title: "Conflict" } },
  ] }));
  assert.equal(result.status, "conflict");
  assert.equal((await h.read(seed.owner, seed.tasks[0].id)).revision, "1");
  assert.equal((await h.inspect()).receipts.length, 1);
});
check("D04: created task and step references are atomic, replayable and server allocated", async (h) => {
  const value = domain("import", { expectedDomainRevision: undefined, items: [
    { kind: "create_task", patch: { prefix: "P", category: "Synthetic topic", title: "Synthetic creation" } },
    { kind: "add_subtask", targetFrom: 0, expectedRevision: "1", patch: { title: "Synthetic step" } },
    { kind: "set_subtask_status", targetFrom: 0, subtaskFrom: 1, expectedRevision: "2", status: "done" },
  ] });
  const result = await h.send(seed.owner, value);
  assert.equal(result.status, "committed"); assert.equal(result.items[0].number, 3);
  const saved = await h.read(seed.owner, result.items[0].targetTaskUuid);
  assert.equal(saved.subtasks[0].status, "done"); assert.equal(saved.revision, "3");
  assert.deepEqual(await h.send(seed.owner, value), result);
  assert.equal((await h.inspect()).tasks.length, 3);
});
check("D05: pending invitations expose version context but not live task notes", async (h) => {
  const invite = await h.send(seed.owner, command(undefined, { kind: "invite_share", patch: undefined, email: "recipient@example.invalid", role: "contributor" }));
  await h.admin("update persistence_v1.accounts set enabled=true where user_id=$1", [seed.recipient]);
  const data = await context(h, seed.recipient);
  assert.equal(data.sharedTasks.length, 0); assert.equal(data.shares[0].task_revision, "2");
  assert.equal(data.shares[0].write_epoch, "1");
  assert.equal((await h.send(seed.recipient, command(invite.task, { kind: "accept_share", patch: undefined, shareId: invite.shareId }))).status, "committed");
  assert.equal((await context(h, seed.recipient)).sharedTasks.length, 1);
});
check("D06: backup preserves bigint strings, covers control schema and never exports OAuth secrets", async (h) => {
  await h.admin("update persistence_v1.accounts set write_epoch=9007199254740993 where user_id=$1", [seed.owner]);
  await h.admin("update public.tasks set revision=9007199254740993 where id=$1", [seed.tasks[0].id]);
  const data = await snapshot(h);
  assert.equal(data.persistence.accounts[0].write_epoch, "9007199254740993");
  assert.ok(data.data.tasks.some((row) => row.revision === "9007199254740993"));
  assert.equal(Object.keys(data.data).length, 10); assert.equal(Object.keys(data.persistence).length, 6);
  assert.ok(data.columns["persistence_v1.receipts"]); assert.equal(data.data.drive_backup_connections, undefined);
  for (const actor of [seed.owner, seed.recipient]) await assert.rejects(h.asActor(actor, "select public.persistence_export_account_v1($1)", [seed.owner]), { code: "42501" });
});
check("D07: restore requires maintenance, preserves revocations and never rewinds dedup or floors", async (h) => {
  const shareId = await h.fixture("accepted_assignment", { taskId: seed.tasks[0].id, subtaskId: "step-1-1" });
  const older = await snapshot(h);
  await h.fixture("revoke_access", { taskId: seed.tasks[0].id });
  const before = await h.inspect(), op = command().operationId;
  await assert.rejects(h.admin("select public.persistence_restore_account_v1($1,$2::jsonb,$3,'1')", [seed.owner, JSON.stringify(older), op]));
  await h.admin("update persistence_v1.accounts set read_only=true where user_id=$1", [seed.owner]);
  const result = (await h.admin("select public.persistence_restore_account_v1($1,$2::jsonb,$3,'1') value", [seed.owner, JSON.stringify(older), op])).rows[0].value;
  assert.equal(result.writeEpoch, "2");
  const after = await h.inspect();
  assert.equal(after.shares.find((row) => row.id === shareId).status, "revoked");
  assert.ok(after.receipts.length > before.receipts.length);
  assert.equal((await h.receipt(seed.owner, op)).status, "committed");
  assert.equal((await h.admin("select public.persistence_restore_account_v1($1,$2::jsonb,$3,'2') value", [seed.owner, JSON.stringify(older), op])).rows[0].value.writeEpoch, "2");
});
check("D08: schema drift and foreign rows roll back a maintenance restore", async (h) => {
  const data = await snapshot(h);
  await h.admin("update persistence_v1.accounts set read_only=true where user_id=$1", [seed.owner]);
  for (const bad of [{ ...data, columns: {} }, { ...data, data: { ...data.data, tasks: [{ ...data.data.tasks[0], user_id: seed.outsider }] } }]) {
    const before = await h.inspect();
    await assert.rejects(h.admin("select public.persistence_restore_account_v1($1,$2::jsonb,$3,'1')", [seed.owner, JSON.stringify(bad), command().operationId]));
    assert.deepEqual(await h.inspect(), before);
  }
});
check("D09: synthetic disaster recovery rehydrates all public and private rows into a fresh isolated database", async (h) => {
  const id = await h.fixture("proposal", { taskId: seed.tasks[0].id, action: { type: "update_task_status", taskId: "P1", status: "waiting" } });
  await h.send(seed.owner, command(undefined, { kind: "apply_ai_proposal", patch: undefined, proposalId: id }));
  const data = await snapshot(h), fresh = await createHarness(structuredClone(seed));
  try {
    for (const table of ["proposal_executions", "proposals", "receipts", "domain_versions", "counters", "accounts"]) await fresh.admin(`delete from persistence_v1.${table}`);
    for (const table of ["assistant_actions", "assistant_messages", "assistant_threads", "task_subtask_assignments", "task_shares", "tasks", "task_taxonomy_items", "user_settings", "notification_receipts", "user_devices"]) await fresh.admin(`delete from public.${table}`);
    for (const table of ["tasks", "task_taxonomy_items", "user_settings", "task_shares", "task_subtask_assignments", "assistant_threads", "assistant_messages", "assistant_actions", "notification_receipts", "user_devices"])
      await fresh.admin(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1::jsonb)`, [JSON.stringify(data.data[table])]);
    for (const table of ["accounts", "counters", "receipts", "proposals", "proposal_executions", "domain_versions"]) await fresh.admin(`insert into persistence_v1.${table} select * from jsonb_populate_recordset(null::persistence_v1.${table},$1::jsonb)`, [JSON.stringify(data.persistence[table])]);
    const restored = await snapshot(fresh);
    assert.deepEqual(restored.data, data.data); assert.deepEqual(restored.persistence, data.persistence);
    assert.equal((await fresh.send(seed.owner, command(undefined, { kind: "apply_ai_proposal", patch: undefined, proposalId: id }))).status, "committed");
    assert.equal((await fresh.inspect()).proposalExecutions.length, 1);
  } finally { await fresh.close(); }
});
check("D10: self export cannot select another account and new accounts start gated", async (h) => {
  const self = (await h.asActor(seed.owner, "select public.persistence_export_self_v1() value")).rows[0].value;
  assert.equal(self.status, "backup"); assert.equal(self.snapshot.owner_user_id, seed.owner);
  assert.ok(self.snapshot.data.tasks.every((row) => row.user_id === seed.owner));
  const id = "10000000-0000-4000-8000-000000000099";
  await h.admin("insert into auth.users(id,email) values($1,'new@example.invalid')", [id]);
  const account = (await h.admin("select enabled,read_only from persistence_v1.accounts where user_id=$1", [id])).rows[0];
  assert.deepEqual(account, { enabled: false, read_only: true });
  assert.equal((await h.admin("select count(*)::integer n from persistence_v1.counters where user_id=$1", [id])).rows[0].n, 2);
});
