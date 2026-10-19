import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalIds, copy, legacyHarness, numbering, owner, task } from "./fixtures.mjs";

test("R01 / T01: legacy same-field stale write loses first edit (risk reproduced)", async () => {
  const h = legacyHarness(), initial = task();
  await h.saveCloudTasks([{ ...initial, title: "Device A" }], owner);
  await h.saveCloudTasks([{ ...initial, title: "Device B" }], owner);
  assert.equal(h.row(1).title, "Device B");
  assert.equal(h.calls.length, 2);
});

test("R02 / T02: different-field edits still overwrite each other (risk reproduced)", async () => {
  const h = legacyHarness(), initial = task();
  await h.saveCloudTasks([{ ...initial, title: "Device A" }], owner);
  await h.saveCloudTasks([{ ...initial, notes: "Device B" }], owner);
  assert.equal(h.row(1).title, initial.title);
  assert.equal(h.row(1).notes, "Device B");
});

test("R03 / T03: full-list save rolls back another task's edit (risk reproduced)", async () => {
  const h = legacyHarness(), initial = [task(1), task(2)];
  await h.saveCloudTasks([{ ...initial[0], title: "Device A" }, initial[1]], owner);
  await h.saveCloudTasks([initial[0], { ...initial[1], title: "Device B" }], owner);
  assert.equal(h.row(1).title, initial[0].title);
  assert.equal(h.row(2).title, "Device B");
});

test("R04 / T04: concurrent snapshots allocate one number and upsert collapses creations", async () => {
  const h = legacyHarness(), { nextTaskNumber } = numbering(), base = [task(1)];
  const a = nextTaskNumber(copy(base), "P"), b = nextTaskNumber(copy(base), "P");
  assert.equal(a, b);
  await h.saveCloudTasks([task(a, { title: "Creation A" })], owner);
  await h.saveCloudTasks([task(b, { title: "Creation B" })], owner);
  assert.equal(h.rows.size, 1);
  assert.equal(h.row(a).title, "Creation B");
});

test("R05 / T11: removal of highest number permits task and step reuse", () => {
  const { nextTaskNumber, nextSubtaskNumber } = numbering();
  assert.equal(nextTaskNumber([task(1)], "P"), 2, "Deleted P2 would be reused");
  assert.equal(nextSubtaskNumber(task().subtasks), 2, "Deleted step 2 would be reused");
});

test("R06 / T07: thrown transport error can follow a committed write", async () => {
  const h = legacyHarness();
  h.loseAcknowledgement();
  await assert.rejects(h.saveCloudTasks([task()], owner), /Synthetic lost ACK/);
  assert.equal(h.row(1).title, task().title);
  h.restoreTransport();
  await h.saveCloudTasks([task(1, { title: "Newer edit" })], owner);
  await h.saveCloudTasks([task()], owner);
  assert.equal(h.row(1).title, task().title, "Blind retry overwrites newer data");
});

test("R07 / T10: stale JSONB replacement loses a completed step", async () => {
  const h = legacyHarness(), initial = task();
  await h.saveCloudTasks([{ ...initial, subtasks: [{ ...initial.subtasks[0], status: "done" }] }], owner);
  await h.saveCloudTasks([{ ...initial, title: "Owner edit" }], owner);
  assert.equal(h.row(1).subtasks[0].status, "open");
});

test("R08: optional-column fallback can report success while omitting steps", async () => {
  const h = legacyHarness();
  h.missingSubtasksColumn();
  await h.saveCloudTasks([task()], owner);
  assert.equal(h.calls.length, 3);
  assert.equal(Object.hasOwn(h.row(1), "subtasks"), false);
});

test("R09 / T22: capped read returns an unmarked partial array", async () => {
  const h = legacyHarness();
  await h.saveCloudTasks([task(1), task(2)], owner);
  h.limitReads(1);
  const rows = await h.fetchCloudTasks(owner);
  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows, "partial"), false);
});

test("B01: client excludes shared and other-owner tasks from writes", async () => {
  const h = legacyHarness();
  await h.saveCloudTasks([task(1), task(2, { sharedWithMe: true }), task(3, { ownerUserId: "other" })], owner);
  assert.deepEqual([...h.rows.values()].map((row) => row.task_number), [1]);
});

test("B02 / T12: standalone fetch maps data without issuing a write", async () => {
  const h = legacyHarness();
  await h.saveCloudTasks([task()], owner);
  h.calls.length = 0;
  assert.equal((await h.fetchCloudTasks(owner))[0].id, "P1");
  assert.deepEqual(h.calls.map((call) => call.kind), ["select"]);
});

test("B03: an empty own-task list does not delete or upsert anything", async () => {
  const h = legacyHarness();
  await h.saveCloudTasks([task()], owner);
  h.calls.length = 0;
  await h.saveCloudTasks([], owner);
  assert.equal(h.rows.size, 1);
  assert.equal(h.calls.length, 0);
});

test("B04: canonical task IDs preserve P/W normalization rules", () => {
  const canonicalTaskId = canonicalIds();
  for (const prefix of ["P", "W"]) {
    for (const suffix of ["19", "019", "-019", "-0019"]) assert.equal(canonicalTaskId(`${prefix}${suffix}`), `${prefix}19`);
  }
  assert.equal(canonicalTaskId("not-a-task"), null);
});

test("B05: completed and cancelled tasks still contribute to current numbering", () => {
  const { nextTaskNumber } = numbering();
  assert.equal(nextTaskNumber([task(1), task(2, { status: "done" }), task(3, { status: "cancelled" })], "P"), 4);
});
