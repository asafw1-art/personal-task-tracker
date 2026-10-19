import assert from "node:assert/strict";
import { syntheticSeed } from "./contract-cases.mjs";

export const uiCases = [];
const define = (id, title, run) => uiCases.push({ id, title, run });
const edit = (ui) => ui.event("edit", { title: "Synthetic draft" });

define("U01", "pending ACK does not look saved; double-click sends once", async (ui) => {
  await edit(ui);
  await ui.event("hold_response");
  await ui.event("save");
  await ui.event("save");
  const view = await ui.view();
  assert.equal(view.status, "submitting");
  assert.equal(view.savedIndicator, false);
  assert.equal(view.sentCommands.length, 1);
});
define("U02", "lost ACK reuses immutable operation and resolves once", async (ui) => {
  await edit(ui);
  await ui.event("save");
  await ui.event("transport_timeout");
  const pending = await ui.view();
  assert.equal(pending.status, "unknown");
  assert.equal(pending.savedIndicator, false);
  await ui.event("check_status");
  const checking = await ui.view();
  assert.deepEqual(checking.activeCommand, pending.activeCommand);
  await ui.event("committed_response");
  assert.equal((await ui.view()).status, "saved");
  assert.equal((await ui.view()).successAnnouncements, 1);
});
define("U03", "reconnect never sends a new offline draft automatically", async (ui) => {
  await ui.event("offline");
  await edit(ui);
  await ui.event("online");
  assert.equal((await ui.view()).sentCommands.length, 0);
  assert.equal((await ui.view()).draft.title, "Synthetic draft");
});
define("U04", "three-way diff includes server-only and locally changed fields", async (ui) => {
  await edit(ui);
  await ui.event("conflict_response", { current: { ...syntheticSeed.tasks[0], revision: "2", notes: "Synthetic remote note" } });
  const { diff } = await ui.view();
  assert.equal(diff.title.base, "Synthetic task 1");
  assert.equal(diff.title.local, "Synthetic draft");
  assert.equal(diff.notes.server, "Synthetic remote note");
  assert.ok(Object.values(diff).every((field) => field.selection === "server"));
  await ui.event("choose_local", { field: "title" });
  await ui.event("confirm_resolution");
  const last = (await ui.view()).sentCommands.at(-1);
  assert.deepEqual(last.patch, { title: "Synthetic draft" });
  assert.equal(last.expectedRevision, "2");
});
define("U05", "a second conflict needs renewed confirmation", async (ui) => {
  await edit(ui);
  await ui.event("conflict_response", { current: { ...syntheticSeed.tasks[0], revision: "2" } });
  await ui.event("choose_local", { field: "title" });
  await ui.event("confirm_resolution");
  await ui.event("conflict_response", { current: { ...syntheticSeed.tasks[0], revision: "3" } });
  const state = await ui.view();
  assert.equal(state.status, "conflict");
  assert.equal(state.draft.title, "Synthetic draft");
  assert.equal(state.confirmationValid, false);
  assert.equal(state.sentCommands.at(-1).expectedRevision, "2");
});
define("U06", "polling and stale replies preserve local overlay", async (ui) => {
  await edit(ui);
  await ui.event("server_snapshot", { ...syntheticSeed.tasks[0], revision: "3" });
  await ui.event("server_snapshot", { ...syntheticSeed.tasks[0], revision: "2" });
  const state = await ui.view();
  assert.equal(state.task.revision, "3");
  assert.equal(state.draft.title, "Synthetic draft");
  assert.equal(state.sentCommands.length, 0);
});
define("U07", "storage quota failure shows volatile-draft warning", async (ui) => {
  await ui.event("storage_failure");
  await edit(ui);
  await ui.event("close_requested");
  const state = await ui.view();
  assert.equal(state.storageWarning, true);
  assert.equal(state.localDurable, false);
  assert.equal(state.closeWarning, true);
});
define("U08", "expired session and account switch do not replay private drafts", async (ui) => {
  await edit(ui);
  await ui.event("session_expired");
  assert.equal((await ui.view()).canSave, false);
  await ui.event("switch_account", { actor: syntheticSeed.outsider });
  await ui.event("old_account_response", { actor: syntheticSeed.owner, task: syntheticSeed.tasks[0] });
  const state = await ui.view();
  assert.equal(state.draft, null);
  assert.equal(state.task, null);
  assert.equal(state.sentCommands.length, 0);
});
define("U09", "revocation removes shared content, draft and export actions", async (ui) => {
  await ui.event("open_shared_assignment");
  await ui.event("edit", { notes: "Synthetic shared draft" });
  await ui.event("access_revoked");
  const state = await ui.view();
  assert.equal(state.task, null);
  assert.equal(state.draft, null);
  assert.equal(state.canSave, false);
  assert.equal(state.canExportDraft, false);
});
define("U10", "AI proposal shows pending until authoritative result", async (ui) => {
  await ui.event("ai_proposal");
  await ui.event("approve_ai");
  await ui.event("approve_ai");
  assert.equal((await ui.view()).savedIndicator, false);
  assert.equal((await ui.view()).sentCommands.length, 1);
  await ui.event("proposal_already_committed");
  assert.equal((await ui.view()).successAnnouncements, 1);
});
define("U11", "maintenance, old protocol and stale epoch block automatic sending", async (ui) => {
  for (const status of ["read_only", "upgrade_required", "stale_epoch"]) {
    await edit(ui);
    await ui.event(status);
    const before = (await ui.view()).sentCommands.length;
    await ui.event("save");
    await ui.event("online");
    assert.equal((await ui.view()).sentCommands.length, before);
    assert.equal((await ui.view()).draft.title, "Synthetic draft");
    await ui.event("reset_synthetic_view");
  }
});
define("U12", "unsaved creation has no final number; unknown blocks a second creation", async (ui) => {
  await ui.event("new_task");
  await edit(ui);
  assert.equal((await ui.view()).finalDisplayId, null);
  await ui.event("save");
  await ui.event("transport_timeout");
  await ui.event("save");
  assert.equal((await ui.view()).sentCommands.length, 1);
  assert.equal((await ui.view()).finalDisplayId, null);
});
define("U13", "atomic bulk rejection cannot display partial success", async (ui) => {
  for (const kind of ["import", "rename_taxonomy"]) {
    await ui.event("bulk_preview", { kind, count: 2 });
    await ui.event("confirm_bulk");
    await ui.event("bulk_rejected");
    assert.equal((await ui.view()).savedIndicator, false);
    assert.equal((await ui.view()).partialSuccessCount, 0);
  }
});
define("U14", "partial list is labelled without discarding cached tasks", async (ui) => {
  await ui.event("seed_cached_list", { tasks: syntheticSeed.tasks });
  await ui.event("partial_list", { tasks: [syntheticSeed.tasks[0]] });
  const state = await ui.view();
  assert.equal(state.partialListWarning, true);
  assert.equal(state.cachedTasks.length, 2);
  assert.equal(state.sentCommands.length, 0);
});
define("U15", "diff exposes null, long text and removed steps without implicit restoration", async (ui) => {
  const longText = "Synthetic detail ".repeat(300);
  await ui.event("edit", { notes: null, title: longText });
  await ui.event("conflict_response", { current: { ...syntheticSeed.tasks[0], revision: "2", subtasks: [] } });
  const state = await ui.view();
  assert.equal(state.diff.notes.local, null);
  assert.equal(state.diff.title.local, longText);
  assert.equal(state.diff.subtasks.canRestoreRemovedIdentity, false);
});
define("U16", "rendered RTL, touch targets, focus, viewport and accessibility", async (ui) => {
  // The adapter must measure a rendered UI, not return a hand-built state model.
  assert.equal(ui.capabilities.renderedUi, true);
  for (const viewport of [{ width: 360, height: 740 }, { width: 1280, height: 800 }]) {
    for (const theme of ["light", "dark"]) {
      await ui.event("render", { viewport, theme });
      await ui.event("open_conflict");
      const metrics = await ui.measure();
      assert.equal(metrics.direction, "rtl");
      assert.ok(metrics.scrollWidth <= viewport.width);
      assert.ok(metrics.minimumTouchTarget >= 44);
      assert.equal(metrics.backgroundScrollLocked, true);
      assert.equal(metrics.focusInsideDialog, true);
      assert.equal(metrics.statusAnnounced, true);
      await ui.event("keyboard_viewport", { height: 360 });
      assert.equal((await ui.measure()).focusedInputVisible, true);
      assert.equal((await ui.measure()).primaryActionVisible, true);
    }
  }
});
