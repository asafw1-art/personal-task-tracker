import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./domains-adapter.mjs";
import { syntheticSeed as seed } from "./contract-cases.mjs";
import { importNormalizers, loadIsolatedModule as load } from "./fixtures.mjs";
const user = { id: seed.owner, email: "owner@example.invalid" };
const check = (name, run) => test(name, { skip: !process.env.PGLITE_MODULE_PATH && "PGlite required" }, async () => {
  const h = await createHarness(structuredClone(seed)), oldStorage = globalThis.localStorage, values = new Map();
  globalThis.localStorage = { get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  let actor = user.id, count = 0, after = () => {};
  const supabase = { auth: { getSession: async () => ({ data: { session: { user: { id: actor }, access_token: "synthetic-token" } } }) }, from: () => { throw new Error("Legacy DML forbidden"); } };
  const api = load("src/lib/persistenceWriters.ts", { "@/lib/supabase": { supabase }, "@/lib/persistenceTransport": {
    fetchPersistencePage: (id, cursor, limit) => h.page(id, { cursor, limit }),
    fetchPersistenceContext: async (id) => (await h.asActor(id, "select public.persistence_context_v1() value")).rows[0].value,
    checkPersistenceOperation: (op, id) => h.receipt(id, op),
    sendPersistenceCommand: async (c, id) => { count++; let r; try { r = await h.send(id, c); }
      catch (e) { if (e.code !== "SYNTHETIC_TRANSPORT_TIMEOUT") throw e; r = { status: "unknown", operationId: c.operationId }; } after(); return r; },
  } });
  const dependencies = { "@/lib/supabase": { supabase }, "@/lib/persistenceWriters": { ...api, versionedPersistenceEnabled: true } };
  const tasks = load("src/lib/supabaseTasks.ts", dependencies), settings = load("src/lib/supabaseUserSettings.ts", dependencies), taxonomy = load("src/lib/supabaseTaxonomy.ts", dependencies);
  try { await run({ h, api, tasks, settings, taxonomy, values, supabase, count: () => count, switchOnReply: () => { after = () => { actor = seed.outsider; }; } }); }
  finally { globalThis.localStorage = oldStorage; await h.close(); }
});
check("W01: real readers do not write and legacy list saving is blocked", async ({ h, api, tasks, settings, taxonomy, count }) => {
  const loaded = await tasks.fetchCloudTasks(user);
  await settings.fetchUserSettings(user); await taxonomy.fetchCloudTaxonomy(); await settings.saveUserSettings(user, {});
  assert.equal(count(), 0); assert.equal((await h.inspect()).receipts.length, 0);
  assert.equal(api.taskCommandBase(loaded[0]).targetTaskUuid, seed.tasks[0].id);
  await assert.rejects(tasks.saveCloudTasks(loaded, user), /רשימה/);
});
check("W02: editor planner uses atomic explicit changes and server numbering", async ({ h, api, tasks }) => {
  const base = (await tasks.fetchCloudTasks(user))[0];
  const next = { ...base, title: "Synthetic editor save", subtasks: [{ ...base.subtasks[0], title: "Synthetic step edit", status: "done" }, { id: "draft", number: 99, title: "Synthetic new step", status: "open" }] };
  assert.equal((await api.writeVersioned(user.id, { kind: "import", items: api.taskEditItems(base, next) })).status, "committed");
  const saved = await h.read(user.id, base.cloudId);
  assert.equal(saved.title, next.title); assert.equal(saved.subtasks[0].id, base.subtasks[0].id); assert.equal(saved.subtasks[1].number, 2);
  assert.equal((await api.writeVersioned(user.id, { kind: "import", items: api.taskEditItems(null, { ...next, subtasks: [{ id: "draft", number: 40, title: "Synthetic created step", status: "done" }] }) })).status, "committed");
  assert.equal((await h.inspect()).tasks.length, 3);
});
check("W03: unknown keeps per-operation identity and resolves without a new write", async ({ h, api, tasks, values, count }) => {
  const base = (await tasks.fetchCloudTasks(user))[0];
  await h.fault("after_commit", "lose_response");
  await assert.rejects(api.writeVersioned(user.id, { kind: "set_task_status", ...api.taskCommandBase(base), status: "waiting" }));
  assert.equal(values.size, 1); assert.ok([...values.keys()][0].endsWith(JSON.parse([...values.values()][0]).operationId));
  await assert.rejects(api.writeVersioned(user.id, { kind: "set_task_status", ...api.taskCommandBase(base), status: "done" }));
  assert.equal(count(), 1); assert.equal((await api.resolvePendingPersistence(user.id)).status, "committed");
  assert.equal(values.size, 0); assert.equal((await h.read(user.id, base.cloudId)).revision, "2");
});
check("W04: failed journal refuses sending and an account switch discards a late reply", async ({ h, api, tasks, count, switchOnReply }) => {
  const base = (await tasks.fetchCloudTasks(user))[0], storage = globalThis.localStorage;
  globalThis.localStorage = { ...storage, setItem: () => { throw new Error("Synthetic quota"); } };
  await assert.rejects(api.writeVersioned(user.id, { kind: "set_task_status", ...api.taskCommandBase(base), status: "waiting" }));
  assert.equal(count(), 0); globalThis.localStorage = storage;
  switchOnReply();
  await assert.rejects(api.writeVersioned(user.id, { kind: "set_task_status", ...api.taskCommandBase(base), status: "waiting" }));
  assert.equal(api.observedTask(user.id, base.cloudId).revision, "1"); assert.equal((await h.read(user.id, base.cloudId)).revision, "2");
});
check("W05: settings/taxonomy writers use baseline versions and bigint edits stay exact", async ({ h, api, tasks, settings, taxonomy }) => {
  await tasks.fetchCloudTasks(user); await settings.fetchUserSettings(user); await taxonomy.fetchCloudTaxonomy();
  await settings.saveUserSettings(user, { displayName: "Synthetic name", theme: "dark" });
  await taxonomy.renameCloudTaxonomy(user, "topic", "Synthetic topic", "Synthetic renamed", "P");
  assert.equal((await h.read(user.id, seed.tasks[0].id)).category, "Synthetic renamed");
  const base = { ...seed.tasks[0], cloudId: seed.tasks[0].id, revision: "9007199254740993" };
  const items = api.taskEditItems(base, { ...base, title: "Synthetic bigint", subtasks: [] });
  assert.equal(items[0].expectedRevision, "9007199254740993"); assert.equal(items[1].expectedRevision, "9007199254740994");
});
test("W06: application import preserves stable UUID step identity and rejects partial normalization", () => {
  const normalizer = importNormalizers();
  const source = { ...seed.tasks[0], id: "P1", cloudId: seed.tasks[0].id, ownerUserId: seed.owner,
    subtasks: [{ ...seed.tasks[0].subtasks[0], id: "50000000-0000-4000-8000-000000000001" }] };
  const value = normalizer.normalizeImportedTask(source);
  assert.equal(value.subtasks[0].id, source.subtasks[0].id); assert.equal(value.cloudId, source.cloudId);
  assert.equal(normalizer.normalizeImportedTask({ ...source, subtasks: [{ ...source.subtasks[0], title: "" }] }), null);
  assert.equal(normalizer.normalizeImportedTask({ ...source, subtasks: [...source.subtasks, ...source.subtasks] }), null);
});
check("W07: a no-op within an atomic edit does not invent a revision or lose the following focus change", async ({ h, api, tasks }) => {
  const base = (await tasks.fetchCloudTasks(user))[0];
  const next = { ...base, title: base.title + " ", focused: true };
  const result = await api.writeVersioned(user.id, { kind: "import", items: api.taskEditItems(base, next) });
  assert.equal(result.status, "committed");
  const saved = await h.read(user.id, base.cloudId);
  assert.equal(saved.title, base.title); assert.equal(saved.focused, true); assert.equal(saved.revision, "2");
});
check("W08: restore retry keeps its operation identity; a later confirmed restore gets a new one", async ({ api, tasks, supabase, values }) => {
  await tasks.fetchCloudTasks(user);
  const originalFetch = globalThis.fetch, sent = [];
  const drive = load("src/lib/driveBackup.ts", { "@/lib/supabase": { supabase }, "@/lib/persistenceWriters": { ...api, versionedPersistenceEnabled: true } });
  try {
    globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); throw new Error("Synthetic lost restore ACK"); };
    await assert.rejects(drive.restoreDriveBackup("synthetic-run"));
    assert.equal(values.size, 1);
    globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ restore: { restoredAt: "synthetic", taskCount: 2 } }); };
    await drive.restoreDriveBackup("synthetic-run"); assert.equal(values.size, 0);
    assert.equal(sent[0].operationId, sent[1].operationId); assert.equal(sent[0].expectedEpoch, "1");
    await drive.restoreDriveBackup("synthetic-run"); assert.notEqual(sent[2].operationId, sent[1].operationId);
  } finally { globalThis.fetch = originalFetch; }
});
