import assert from "node:assert/strict";
import { test } from "node:test";
import { loadIsolatedModule } from "./fixtures.mjs";
import { task, owner, outsider } from "./fixtures.mjs";

function setup() {
  const previous = globalThis.localStorage, data = new Map();
  globalThis.localStorage = { get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null, getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  return { api: loadIsolatedModule("src/lib/persistenceUx.ts", {}), data, close: () => { globalThis.localStorage = previous; } };
}
const base = () => task(1, { cloudId: "40000000-0000-4000-8000-000000000001", revision: "9007199254740993", writeEpoch: "1" });
test("X01: durable drafts are isolated by account, UUID and base; later base replaces the same target only", () => {
  const { api, close } = setup(); try {
    const b = base(), d = { ...b, title: "Synthetic draft" };
    assert.equal(api.storeTaskDraft(owner.id, b, d), true);
    assert.equal(api.persistenceSnapshot(outsider.id).drafts.length, 0);
    api.storeTaskDraft(owner.id, { ...b, revision: "9007199254740994" }, d);
    assert.equal(api.persistenceSnapshot(owner.id).drafts.length, 1);
    api.hydratePersistenceWorkspace(owner.id);
    assert.equal(api.persistenceSnapshot(owner.id).drafts[0].draft.title, d.title);
    api.removeTaskDraft(owner.id, api.draftKey(b));
    assert.equal(api.persistenceSnapshot(owner.id).drafts.length, 0);
  } finally { close(); }
});
test("X02: quota failure cannot promise durable storage", () => {
  const { api, close } = setup(); try {
    localStorage.setItem = () => { throw new Error("Synthetic quota"); };
    assert.equal(api.storeTaskDraft(owner.id, base(), { ...base(), notes: "Synthetic volatile note" }), false);
    assert.equal(api.persistenceSnapshot(owner.id).storageWarning, true);
    assert.equal(api.persistenceSnapshot(owner.id).drafts.length, 1);
  } finally { close(); }
});
test("X03: revoked shared drafts and content are purged, technical outcomes have no snapshots", () => {
  const { api, data, close } = setup(); try {
    const b = { ...base(), sharedWithMe: true };
    api.storeTaskDraft(owner.id, b, b); api.reconcileDraftAccess(owner.id, []);
    api.recordPersistenceOperation(owner.id, { operationId: "synthetic-operation", kind: "patch_task", targetTaskUuid: b.cloudId }, "not_found_or_forbidden", { status: "not_found_or_forbidden", task: b });
    assert.equal(api.persistenceSnapshot(owner.id).drafts.length, 0);
    assert.equal([...data.values()].some((value) => value.includes(b.title)), false);
  } finally { close(); }
});
test("X04: reload discovers exact immutable pending operations without dispatching", () => {
  const { api, close } = setup(); try {
    const command = { operationId: "synthetic-operation", kind: "patch_task", targetTaskUuid: base().cloudId, patch: { title: "Synthetic pending" } };
    localStorage.setItem(api.operationPrefix(owner.id) + command.operationId, JSON.stringify(command));
    api.hydratePersistenceWorkspace(owner.id);
    assert.equal(api.persistenceSnapshot(owner.id).operations[0].status, "unknown");
    assert.equal(localStorage.getItem(api.operationPrefix(owner.id) + command.operationId), JSON.stringify(command));
  } finally { close(); }
});
test("X05: diff includes remote-only fields, explicit null and full text; removed step identity cannot be selected", () => {
  const { api, close } = setup(); try {
    const b = base(), title = "Synthetic long text ".repeat(300), d = { ...b, title, notes: null };
    const server = { ...b, notes: "Synthetic remote", subtasks: [], revision: "9007199254740994" };
    const rows = api.taskDiff(b, server, d);
    assert.equal(rows.find((row) => row.field === "title").local, title);
    assert.equal(rows.find((row) => row.field === "notes").local, null);
    assert.equal(rows.find((row) => row.field === "notes").server, server.notes);
    assert.equal(rows.find((row) => row.field === "subtasks").selectable, false);
    assert.deepEqual(api.resolvedTask(server, d, new Set(["title"])), { ...server, title });
  } finally { close(); }
});
test("X06: ordering compares exact bigints and epoch before revision", () => {
  const { api, close } = setup(); try {
    const b = base();
    assert.deepEqual(api.newerTask(b, { ...b, revision: "9007199254740992" }), b);
    assert.equal(api.newerTask(b, { ...b, revision: "1", writeEpoch: "2" }).writeEpoch, "2");
    assert.deepEqual(api.newerTask(b, { ...b, revision: "999999999999999999", writeEpoch: "0" }), b);
  } finally { close(); }
});
