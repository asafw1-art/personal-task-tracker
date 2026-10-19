import assert from "node:assert/strict";

// Test-only port. No reference engine: package 6 must supply the real implementation.
export const cases = [];
const define = (id, title, run) => cases.push({ id, title, run });
export const syntheticSeed = {
  owner: "10000000-0000-4000-8000-000000000001",
  recipient: "10000000-0000-4000-8000-000000000002",
  outsider: "10000000-0000-4000-8000-000000000003",
  tasks: [1, 2].map((number) => ({
    id: `20000000-0000-4000-8000-00000000000${number}`,
    prefix: "P", number, revision: "1", writeEpoch: "1",
    title: `Synthetic task ${number}`, notes: "Synthetic note", category: "Synthetic topic",
    priority: "normal", status: "open", dueDate: "2026-01-01", completedAt: null,
    subtasks: [{ id: `step-${number}-1`, number: 1, title: "Synthetic step", status: "open" }],
  })),
};
let operationSequence = 0;
export function command(task = syntheticSeed.tasks[0], extra = {}) {
  return {
    protocolVersion: 1,
    operationId: `40000000-0000-4000-8000-${String(++operationSequence).padStart(12, "0")}`,
    kind: "patch_task", targetTaskUuid: task.id,
    expectedRevision: task.revision, expectedWriteEpoch: task.writeEpoch,
    patch: { title: "Synthetic edit" }, ...extra,
  };
}
const committed = (reply) => { assert.equal(reply.status, "committed"); return reply; };
const conflictPair = (replies) => assert.deepEqual(replies.map((reply) => reply.status).sort(), ["committed", "conflict"]);
const read = (h, task = syntheticSeed.tasks[0], actor = syntheticSeed.owner) => h.read(actor, task.id);

define("T01", "same-field race admits one commit and preserves the other intent", async (h) => {
  const commands = [command(), command(undefined, { patch: { title: "Other edit" } })];
  const results = await h.race(commands.map((value) => ({ actor: syntheticSeed.owner, command: value })));
  conflictPair(results);
  assert.equal((await read(h)).title, commands[results.findIndex((reply) => reply.status === "committed")].patch.title);
  assert.equal((await read(h)).revision, "2");
});
define("T02", "different fields on stale revision still conflict", async (h) => {
  committed(await h.send(syntheticSeed.owner, command()));
  const result = await h.send(syntheticSeed.owner, command(undefined, { patch: { notes: "Other device" } }));
  assert.equal(result.status, "conflict");
  assert.equal((await read(h)).notes, "Synthetic note");
});
define("T03", "independent task writes do not roll each other back", async (h) => {
  const replies = await h.race(syntheticSeed.tasks.map((task) => ({ actor: syntheticSeed.owner, command: command(task) })));
  replies.forEach(committed);
  for (const task of syntheticSeed.tasks) assert.equal((await read(h, task)).title, "Synthetic edit");
});
define("T04", "parallel creates receive distinct server UUIDs and numbers", async (h) => {
  const replies = await h.race([1, 2].map(() => ({ actor: syntheticSeed.owner, command: command(undefined, {
    kind: "create_task", targetTaskUuid: undefined, expectedRevision: undefined,
    patch: { prefix: "P", title: "Synthetic creation", category: "Synthetic topic", priority: "normal" },
  }) })));
  replies.forEach(committed);
  assert.equal(new Set(replies.map((reply) => reply.task.id)).size, 2);
  assert.equal(new Set(replies.map((reply) => reply.task.number)).size, 2);
  assert.ok(replies.every((reply) => reply.task.number > 2));
});
define("T05", "concurrent duplicate operation and lost-ACK replay have one effect", async (h) => {
  const value = command(), request = { actor: syntheticSeed.owner, command: value };
  const results = await h.race([request, structuredClone(request)]);
  results.forEach(committed);
  assert.equal(results[0].revision, results[1].revision);
  committed(await h.send(syntheticSeed.owner, value));
  assert.equal((await read(h)).revision, "2");
  assert.equal((await h.inspect()).receipts.filter((item) => item.operationId === value.operationId).length, 1);
});
define("T06", "operation ID cannot be rebound to different content", async (h) => {
  const value = command();
  committed(await h.send(syntheticSeed.owner, value));
  assert.equal((await h.send(syntheticSeed.owner, { ...value, patch: { title: "Forbidden replay" } })).status, "idempotency_mismatch");
  assert.equal((await read(h)).title, "Synthetic edit");
});
define("T07", "timeout before and after commit is safe to replay", async (h) => {
  for (const point of ["before_commit", "after_commit"]) {
    const current = await read(h), value = command(current, { patch: { title: `Synthetic ${point}` } });
    await h.fault(point, "lose_response");
    await assert.rejects(h.send(syntheticSeed.owner, value), { code: "SYNTHETIC_TRANSPORT_TIMEOUT" });
    committed(await h.send(syntheticSeed.owner, value));
    assert.equal(BigInt((await read(h)).revision), BigInt(current.revision) + 1n);
  }
});
define("T08", "one AI proposal cannot execute twice with different operation IDs", async (h) => {
  const proposalId = await h.fixture("proposal", { taskId: syntheticSeed.tasks[0].id,
    action: { type: "update_task_status", taskId: "P1", status: "waiting", label: "Synthetic status proposal" } });
  const replies = await h.race([1, 2].map(() => ({ actor: syntheticSeed.owner,
    command: command(undefined, { kind: "apply_ai_proposal", proposalId, patch: undefined }),
  })));
  replies.forEach(committed);
  assert.equal((await read(h)).revision, "2");
  assert.equal((await h.inspect()).proposalExecutions.filter((item) => item.proposalId === proposalId).length, 1);
});
define("T09", "revocation wins before a queued contributor update", async (h) => {
  await h.fixture("accepted_assignment", { taskId: syntheticSeed.tasks[0].id, subtaskId: "step-1-1" });
  await h.fixture("revoke_access", { taskId: syntheticSeed.tasks[0].id });
  const result = await h.send(syntheticSeed.recipient, command(await read(h), {
    kind: "set_subtask_status", subtaskId: "step-1-1", status: "done", patch: undefined,
  }));
  assert.equal(result.status, "not_found_or_forbidden");
  assert.equal((await read(h)).subtasks[0].status, "open");
});
define("T10", "owner and contributor race cannot replace the step array", async (h) => {
  await h.fixture("accepted_assignment", { taskId: syntheticSeed.tasks[0].id, subtaskId: "step-1-1" });
  const current = await read(h);
  const results = await h.race([
    { actor: syntheticSeed.owner, command: command(current) },
    { actor: syntheticSeed.recipient, command: command(current, { kind: "set_subtask_status", subtaskId: "step-1-1", status: "done", patch: undefined }) },
  ]);
  conflictPair(results);
  const final = await read(h);
  if (results[1].status === "committed") assert.equal(final.subtasks[0].status, "done");
  if (results[0].status === "committed") assert.equal(final.title, "Synthetic edit");
});
define("T11", "task and subtask high-water marks survive deletion", async (h) => {
  await h.fixture("remove_highest_task_and_step", {});
  const created = committed(await h.send(syntheticSeed.owner, command(undefined, { kind: "create_task", targetTaskUuid: undefined,
    expectedRevision: undefined, patch: { prefix: "P", title: "Synthetic new task", category: "Synthetic topic" } })));
  assert.ok(created.task.number > 2);
  const current = await read(h);
  const added = committed(await h.send(syntheticSeed.owner, command(current, { kind: "add_subtask", patch: { title: "Synthetic new step" } })));
  assert.ok(added.task.subtasks.at(-1).number > 1);
});
define("T12", "read, polling and focus never issue a write", async (h) => {
  const before = await h.inspect();
  await read(h);
  const client = await h.client();
  await client.event("poll");
  await client.event("focus");
  assert.deepEqual(await h.inspect(), before);
  assert.equal((await client.view()).sentCommands.length, 0);
});
define("T13", "draft and operation survive reload without cross-account replay", async (h) => {
  const client = await h.client();
  await client.event("offline");
  await client.event("edit", { title: "Synthetic local draft" });
  await client.event("reload");
  assert.equal((await client.view()).draft.title, "Synthetic local draft");
  await client.event("online");
  assert.equal((await client.view()).sentCommands.length, 0);
  await client.event("save");
  await client.event("transport_timeout");
  const pending = (await client.view()).activeCommand;
  assert.ok(pending?.operationId);
  await client.event("reload");
  assert.deepEqual((await client.view()).activeCommand, pending);
  await client.event("switch_account", { actor: syntheticSeed.outsider });
  assert.equal((await client.view()).draft, null);
});
define("T14", "storage failure warns and never promises local durability", async (h) => {
  const client = await h.client();
  await client.event("storage_failure");
  await client.event("edit", { title: "Synthetic volatile draft" });
  const state = await client.view();
  assert.equal(state.localDurable, false);
  assert.equal(state.storageWarning, true);
  assert.equal(state.draft.title, "Synthetic volatile draft");
});
define("T15", "legacy REST and RPC task writes are denied at the data boundary", async (h) => {
  const before = await h.inspect();
  for (const route of ["rest", "legacy_rpc"]) {
    assert.equal((await h.legacyWrite(syntheticSeed.owner, route, { title: "Synthetic bypass" })).status, "denied");
  }
  assert.deepEqual(await h.inspect(), before);
  assert.equal((await read(h)).title, "Synthetic task 1");
});
define("T16", "immutable or unknown patch fields are rejected atomically", async (h) => {
  for (const patch of [{ number: 99 }, { prefix: "W" }, { id: syntheticSeed.tasks[1].id },
    { user_id: syntheticSeed.outsider }, { revision: "99" }, { arbitrary: "unknown" }]) {
    const before = await read(h);
    assert.equal((await h.send(syntheticSeed.owner, command(before, { patch }))).status, "validation_failed");
    assert.deepEqual(await read(h), before);
  }
});
define("T17", "import fault rolls back every row, never matches by display ID alone", async (h) => {
  const before = await h.inspect();
  await h.fault("import_after_first_write", "constraint_failure");
  await assert.rejects(h.send(syntheticSeed.owner, command(undefined, { kind: "import", patch: undefined,
    targetTaskUuid: undefined, expectedRevision: undefined,
    items: syntheticSeed.tasks.map((task) => ({ kind: "patch_task", targetTaskUuid: task.id, expectedRevision: task.revision, patch: { title: "Synthetic imported title" } })) })), { code: "SYNTHETIC_CONSTRAINT_FAILURE" });
  assert.deepEqual(await h.inspect(), before);
  assert.equal((await h.send(syntheticSeed.owner, command(undefined, { kind: "import", patch: undefined,
    targetTaskUuid: undefined, expectedRevision: undefined, items: [{ displayId: "P1", title: "Unmapped legacy record" }] }))).status, "validation_failed");
});
define("T18", "rename-before-create schedule cannot reintroduce removed category", async (h) => {
  const taxonomy = await h.fixture("taxonomy_version", {});
  const rename = command(undefined, { kind: "rename_taxonomy", patch: undefined,
    targetTaskUuid: undefined, expectedRevision: undefined, expectedDomainRevision: taxonomy.revision, itemType: "topic", prefix: "P", from: "Synthetic topic", to: "Renamed synthetic topic" });
  committed(await h.send(syntheticSeed.owner, rename));
  const result = await h.send(syntheticSeed.owner, command(undefined, { kind: "create_task", targetTaskUuid: undefined,
    expectedRevision: undefined, expectedTaxonomyRevision: taxonomy.revision,
    patch: { prefix: "P", title: "Synthetic creation", category: "Synthetic topic" } }));
  assert.ok(["conflict", "validation_failed"].includes(result.status));
  assert.ok((await h.inspect()).tasks.filter((task) => task.prefix === "P").every((task) => task.category !== "Synthetic topic"));
});
define("T19", "restore changes epoch but never regresses counters or dedup", async (h) => {
  const value = command();
  committed(await h.send(syntheticSeed.owner, value));
  const before = await h.inspect();
  await h.fixture("restore_older_snapshot", {});
  const after = await h.inspect();
  assert.ok(BigInt(after.writeEpoch) > BigInt(before.writeEpoch));
  for (const prefix of ["P", "W"]) assert.ok(BigInt(after.counters[prefix]) >= BigInt(before.counters[prefix]));
  assert.ok(after.receipts.some((item) => item.operationId === value.operationId));
  assert.equal((await h.send(syntheticSeed.owner, command())).status, "stale_epoch");
});
define("T20", "a revoked actor cannot retrieve old receipt content or execute again", async (h) => {
  await h.fixture("accepted_assignment", { taskId: syntheticSeed.tasks[0].id, subtaskId: "step-1-1" });
  const value = command(await read(h), { kind: "set_subtask_status", subtaskId: "step-1-1", status: "done", patch: undefined });
  committed(await h.send(syntheticSeed.recipient, value));
  await h.fixture("revoke_access", { taskId: syntheticSeed.tasks[0].id });
  const before = await h.inspect();
  const receipt = await h.receipt(syntheticSeed.recipient, value.operationId);
  assert.equal(receipt.status, "not_found_or_forbidden");
  assert.equal(receipt.task, undefined);
  const replay = await h.send(syntheticSeed.recipient, value);
  assert.equal(replay.status, "not_found_or_forbidden");
  assert.deepEqual(await h.inspect(), before);
});
define("T21", "out-of-order replies do not regress bigint revisions or switch accounts", async (h) => {
  const client = await h.client();
  await client.event("server_snapshot", { ...syntheticSeed.tasks[0], revision: "9007199254740993" });
  await client.event("server_snapshot", { ...syntheticSeed.tasks[0], revision: "9007199254740992" });
  assert.equal((await client.view()).task.revision, "9007199254740993");
  await client.event("switch_account", { actor: syntheticSeed.outsider });
  await client.event("old_account_response", { task: syntheticSeed.tasks[0], actor: syntheticSeed.owner });
  assert.equal((await client.view()).task, null);
});
define("T22", "pagination invalidates a stale cursor rather than inferring deletions", async (h) => {
  const first = await h.page(syntheticSeed.owner, { limit: 1 });
  assert.equal(first.complete, false);
  assert.ok(first.cursor);
  committed(await h.send(syntheticSeed.owner, command()));
  assert.equal((await h.page(syntheticSeed.owner, { cursor: first.cursor, limit: 1 })).status, "restart_required");
  assert.equal((await h.inspect()).tasks.length, 2);
});
define("T23", "null, omitted fields, status and server dates follow domain rules", async (h) => {
  let current = await read(h);
  committed(await h.send(syntheticSeed.owner, command(current, { patch: { notes: null } })));
  current = await read(h);
  assert.equal(current.notes, null);
  assert.equal(current.dueDate, "2026-01-01");
  committed(await h.send(syntheticSeed.owner, command(current, { kind: "set_subtask_status", patch: undefined, subtaskId: "step-1-1", status: "done" })));
  current = await read(h);
  assert.equal(current.status, "in_progress");
  committed(await h.send(syntheticSeed.owner, command(current, { kind: "set_task_status", patch: undefined, status: "done" })));
  current = await read(h);
  assert.ok(current.completedAt);
  committed(await h.send(syntheticSeed.owner, command(current, { kind: "set_task_status", patch: undefined, status: "open" })));
  current = await read(h);
  assert.equal(current.completedAt, null);
  const noOp = committed(await h.send(syntheticSeed.owner, command(current, { patch: { title: current.title } })));
  assert.match(noOp.revision, /^\d+$/);
});
define("T24", "receipt failure or deadlock rolls back effect and operation claim", async (h) => {
  for (const fault of ["receipt_insert_failure", "deadlock"]) {
    const before = await h.inspect(), value = command(await read(h));
    await h.fault("before_commit", fault);
    await assert.rejects(h.send(syntheticSeed.owner, value), { code: "SYNTHETIC_TRANSACTION_ABORT" });
    assert.deepEqual(await h.inspect(), before);
    committed(await h.send(syntheticSeed.owner, value));
    assert.equal((await h.inspect()).receipts.filter((item) => item.operationId === value.operationId).length, 1);
  }
});
