import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./collaboration-adapter.mjs";
import { command, syntheticSeed as seed } from "./contract-cases.mjs";

const check = (title, run) => test(title, { skip: !process.env.PGLITE_MODULE_PATH && "Local PGlite required" }, async () => {
  const h = await createHarness(structuredClone(seed));
  try { await run(h); } finally { await h.close(); }
});
const action = { type: "update_task_status", taskId: "P1", status: "waiting", label: "Synthetic proposal" };
const proposal = (h) => h.fixture("proposal", { taskId: seed.tasks[0].id, action });
const execute = (id) => command(undefined, { kind: "apply_ai_proposal", patch: undefined, proposalId: id });
const assignment = (h) => h.fixture("accepted_assignment", { taskId: seed.tasks[0].id, subtaskId: "step-1-1" });

check("A01: AI receipt failure rolls back task, execution and done marker together", async (h) => {
  const id = await proposal(h), before = await h.inspect();
  await h.fault("before_commit", "receipt_insert_failure");
  await assert.rejects(h.send(seed.owner, execute(id)), { code: "SYNTHETIC_TRANSACTION_ABORT" });
  assert.deepEqual(await h.inspect(), before);
  assert.equal((await h.send(seed.owner, execute(id))).status, "committed");
  const after = await h.inspect();
  assert.equal(after.proposalExecutions.length, 1);
  assert.equal(after.messages[0].action_status, "done");
  assert.equal(after.tasks[0].revision, 2);
});
check("A02: changed, legacy-done or stale-epoch proposals cannot execute", async (h) => {
  const id = await proposal(h);
  await h.admin("update public.assistant_messages set proposed_action=jsonb_set(proposed_action,'{status}','\"done\"') where id=$1", [id]);
  assert.equal((await h.send(seed.owner, execute(id))).status, "validation_failed");
  await h.admin("update public.assistant_messages set proposed_action=$2::jsonb,action_status='done' where id=$1", [id, JSON.stringify(action)]);
  assert.equal((await h.send(seed.owner, execute(id))).status, "not_found_or_forbidden");
  await h.admin("update public.assistant_messages set action_status='proposed',persistence_epoch=2 where id=$1", [id]);
  assert.equal((await h.send(seed.owner, execute(id))).status, "not_found_or_forbidden");
  assert.equal((await h.read(seed.owner, seed.tasks[0].id)).revision, "1");
  assert.equal((await h.inspect()).proposalExecutions.length, 0);
});
check("A03: AI execution is actor-bound and cannot redirect its approved target", async (h) => {
  const id = await proposal(h);
  await h.admin("update persistence_v1.accounts set enabled=true,read_only=false where user_id=$1", [seed.outsider]);
  assert.equal((await h.send(seed.outsider, execute(id))).status, "not_found_or_forbidden");
  assert.equal((await h.send(seed.owner, { ...execute(id), targetTaskUuid: seed.tasks[1].id })).status, "validation_failed");
  assert.equal((await h.inspect()).receipts.length, 0);
});
check("A04: chat retention does not erase execution identity or prevent message deletion", async (h) => {
  const id = await proposal(h);
  assert.equal((await h.send(seed.owner, execute(id))).status, "committed");
  await h.admin("delete from public.assistant_messages where id=$1", [id]);
  assert.equal((await h.inspect()).proposalExecutions.length, 1);
  assert.equal((await h.send(seed.owner, execute(id))).status, "not_found_or_forbidden");
});
check("A05: lost AI acknowledgement is resolved by the same receipt and one execution", async (h) => {
  const id = await proposal(h), value = execute(id);
  await h.fault("after_commit", "lose_response");
  await assert.rejects(h.send(seed.owner, value), { code: "SYNTHETIC_TRANSPORT_TIMEOUT" });
  assert.equal((await h.receipt(seed.owner, value.operationId)).status, "committed");
  assert.equal((await h.send(seed.owner, value)).status, "committed");
  assert.equal((await h.send(seed.owner, execute(id))).status, "committed");
  assert.equal((await h.read(seed.owner, seed.tasks[0].id)).revision, "2");
  assert.equal((await h.inspect()).proposalExecutions.length, 1);
});
check("A06: stale task versions conflict without marking AI done", async (h) => {
  const id = await proposal(h);
  assert.equal((await h.send(seed.owner, command())).status, "committed");
  assert.equal((await h.send(seed.owner, execute(id))).status, "conflict");
  const state = await h.inspect();
  assert.equal(state.messages[0].action_status, "proposed");
  assert.equal(state.proposalExecutions.length, 0);
  assert.equal(state.tasks[0].status, "open");
});
check("A07: existing AI create and step actions use server identity and stable step IDs", async (h) => {
  const createdId = await h.fixture("proposal", { taskId: seed.tasks[0].id, action: { type: "create_task",
    task: { prefix: "P", title: "Synthetic AI creation", category: "Synthetic topic" } } });
  const create = command(undefined, { kind: "apply_ai_proposal", patch: undefined, proposalId: createdId, targetTaskUuid: undefined, expectedRevision: undefined });
  const created = await h.send(seed.owner, create);
  assert.equal(created.status, "committed"); assert.equal(created.task.number, 3);
  const replay = await h.send(seed.owner, { ...create, operationId: command().operationId });
  assert.equal(replay.targetTaskUuid, created.targetTaskUuid);
  const addedId = await h.fixture("proposal", { taskId: seed.tasks[0].id, action: { type: "add_subtask", taskId: "P-001", subtask: { title: "Synthetic AI step" } } });
  const added = await h.send(seed.owner, execute(addedId));
  assert.equal(added.status, "committed"); assert.equal(added.task.subtasks.length, 2);
  const completedId = await h.fixture("proposal", { taskId: seed.tasks[0].id, action: { type: "update_subtask_status", taskId: "P01", subtaskNumber: 2, status: "done" } });
  const completed = await h.send(seed.owner, command(added.task, { kind: "apply_ai_proposal", patch: undefined, proposalId: completedId }));
  assert.equal(completed.status, "committed");
  assert.equal(completed.task.subtasks[1].id, added.task.subtasks[1].id);
  assert.equal(completed.task.subtasks[1].status, "done");
});
check("S01: viewer and outsider cannot change a shared step", async (h) => {
  const shareId = await assignment(h), current = await h.read(seed.owner, seed.tasks[0].id);
  await h.admin("update public.task_shares set role='viewer' where id=$1", [shareId]);
  const value = command(current, { kind: "set_subtask_status", patch: undefined, subtaskId: "step-1-1", status: "done" });
  for (const actor of [seed.recipient, seed.outsider]) assert.equal((await h.send(actor, value)).status, "not_found_or_forbidden");
  assert.equal((await h.read(seed.owner, seed.tasks[0].id)).subtasks[0].status, "open");
});
check("S02: leaving a share hides current and historical task snapshots", async (h) => {
  const shareId = await assignment(h), current = await h.read(seed.owner, seed.tasks[0].id);
  const value = command(current, { kind: "leave_share", patch: undefined, shareId });
  const result = await h.send(seed.recipient, value);
  assert.equal(result.status, "committed"); assert.equal(result.task, undefined);
  assert.equal(await h.read(seed.recipient, current.id), null);
  assert.equal((await h.receipt(seed.recipient, value.operationId)).status, "not_found_or_forbidden");
  const state = await h.inspect();
  assert.ok(state.assignments.every((item) => item.ended_at));
});
check("S03: personal focus has its own version without changing the task revision", async (h) => {
  const shareId = await assignment(h), current = await h.read(seed.owner, seed.tasks[0].id);
  const share = (await h.inspect()).shares.find((item) => item.id === shareId);
  const value = command(current, { kind: "set_shared_focus", patch: undefined, shareId, focused: true, expectedShareRevision: String(share.revision) });
  const result = await h.send(seed.recipient, value);
  assert.equal(result.status, "committed");
  assert.equal(result.shareRevision, String(Number(share.revision) + 1));
  assert.equal((await h.read(seed.owner, current.id)).revision, current.revision);
  assert.equal((await h.send(seed.recipient, { ...value, operationId: command().operationId, focused: false })).status, "validation_failed");
  assert.equal((await h.inspect()).shares[0].focused, true);
});
check("S04: collaboration reinstall preserves data and private helpers remain inaccessible", async (h) => {
  await assignment(h);
  const before = await h.inspect();
  await h.reapplyCollaboration();
  assert.deepEqual(await h.inspect(), before);
  const result = (await h.admin(`select
    has_function_privilege('authenticated','persistence_v1.collaboration_command(jsonb)','execute') as internal,
    has_function_privilege('authenticated','public.task_share_snapshot(uuid)','execute') as snapshot,
    has_function_privilege('anon','public.persistence_command_v1(jsonb)','execute') as anonymous`)).rows[0];
  assert.deepEqual(result, { internal: false, snapshot: false, anonymous: false });
});
check("S05: no-op assignment and focus preserve domain versions", async (h) => {
  const shareId = await assignment(h), current = await h.read(seed.owner, seed.tasks[0].id);
  const before = await h.inspect();
  assert.equal((await h.send(seed.owner, command(current, { kind: "assign_subtask", patch: undefined, shareId, subtaskId: "step-1-1" }))).status, "committed");
  assert.equal((await h.send(seed.recipient, command(current, { kind: "set_shared_focus", patch: undefined, shareId,
    expectedShareRevision: String(before.shares[0].revision), focused: before.shares[0].focused }))).status, "committed");
  const after = await h.inspect();
  assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(after.shares, before.shares); assert.deepEqual(after.assignments, before.assignments);
});
check("S06: failed revocation restores share, assignment and root version atomically", async (h) => {
  const shareId = await assignment(h), current = await h.read(seed.owner, seed.tasks[0].id), before = await h.inspect();
  await h.fault("before_commit", "receipt_insert_failure");
  await assert.rejects(h.send(seed.owner, command(current, { kind: "revoke_share", patch: undefined, shareId })), { code: "SYNTHETIC_TRANSACTION_ABORT" });
  assert.deepEqual(await h.inspect(), before);
  assert.ok(await h.read(seed.recipient, current.id));
});
