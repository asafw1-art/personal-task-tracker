// Real Next UI + real staged SQL. All identities/content/network are synthetic; loopback only.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { capabilities as previous, createHarness as createSql } from "./domains-adapter.mjs";
import { command } from "./contract-cases.mjs";
const baseURL = process.env.PERSISTENCE_UI_URL ?? "http://localhost:3106";
if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Loopback UI only");
export const capabilities = { ...previous, renderedUi: true, supportedCases: [...previous.supportedCases, "T12", "T13", "T14", "T21", ...Array.from({ length: 16 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`)] };
const until = async (predicate, message = "UI condition timed out") => {
  const end = Date.now() + 10_000;
  while (!await predicate()) { if (Date.now() > end) throw new Error(message); await new Promise((resolve) => setTimeout(resolve, 40)); }
};
export async function createHarness(seed) {
  const h = await createSql(seed), close = h.close.bind(h);
  let ui;
  h.client = async () => ui ??= await browserClient(h, seed);
  h.close = async () => { if (ui) await ui.close(); await close(); };
  return h;
}
async function browserClient(h, seed) {
  assert.ok(process.env.PLAYWRIGHT_MODULE_PATH, "PLAYWRIGHT_MODULE_PATH required");
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  let actor = seed.owner, queued = [], sent = [], readOverride = null, partial = false, forcedStatus = null, reads = 0;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const session = (id) => {
    const email = id === seed.owner ? "owner@example.invalid" : id === seed.recipient ? "recipient@example.invalid" : "outsider@example.invalid";
    return { access_token: [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify({ sub: id, email, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now()/1000)+3600 })).toString("base64url"), "synthetic"].join("."), refresh_token: "synthetic", token_type: "bearer", expires_at: Math.floor(Date.now()/1000)+3600,
      user: { id, email, aud: "authenticated", role: "authenticated", user_metadata: {} } };
  };
  await context.addInitScript((initial) => {
    if (!localStorage.getItem("sb-synthetic-auth-token")) localStorage.setItem("sb-synthetic-auth-token", JSON.stringify(initial));
    localStorage.setItem("asaf-task-tracker-theme-v1", "light");
  }, session(actor));
  await context.route("**/*", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.hostname === "synthetic.invalid") {
      if (url.pathname.includes("/auth/")) { await route.fulfill({ json: session(actor).user }); return; }
      const table = url.pathname.split("/").at(-1);
      if (["assistant_threads", "assistant_messages", "assistant_actions", "task_subtask_assignments"].includes(table) && req.method() === "GET") {
        const rows = table === "task_subtask_assignments" ? (await h.admin("select a.* from public.task_subtask_assignments a join public.tasks t on t.id=a.task_id where t.user_id=$1 or exists(select 1 from public.task_shares s where s.task_id=t.id and s.shared_with_user_id=$1 and s.status='accepted')", [actor])).rows
          : (await h.admin(`select * from public.${table} where user_id=$1`, [actor])).rows;
        const filtered = rows.filter((row) => (!url.searchParams.has("deleted_at") || !row.deleted_at) && (!url.searchParams.has("archived_at") || !row.archived_at));
        await route.fulfill({ json: req.headers().accept?.includes("object+json") ? filtered[0] ?? null : filtered }); return;
      }
      await route.fulfill({ json: [], headers: { "Content-Range": "0-0/0" } }); return;
    }
    if (url.origin !== new URL(baseURL).origin) { await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (url.pathname !== "/api/persistence") { await route.fulfill({ status: 503, json: { error: "Synthetic service disabled" } }); return; }
    if (req.method() === "POST") {
      const value = req.postDataJSON();
      if (value.kind === "prepare_ai_proposal") { await route.fulfill({ json: await h.send(actor, value) }); return; }
      sent.push(value);
      queued.push({ route, value, actor, forcedStatus });
      return;
    }
    let result;
    if (url.searchParams.has("context")) result = (await h.asActor(actor, "select public.persistence_context_v1() value")).rows[0].value;
    else if (url.searchParams.has("operationId")) result = await h.receipt(actor, url.searchParams.get("operationId"));
    else {
      reads++;
      result = partial ? { status: "restart_required" } : await h.page(actor, { limit: 200 });
      if (readOverride && result.tasks) result.tasks = result.tasks.map((row) => row.id === seed.tasks[0].id ? readOverride : row);
    }
    await route.fulfill({ status: result.status === "restart_required" ? 409 : 200, json: result });
  });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator(".task-card").first().waitFor();
  const workspace = () => page.evaluate((id) => JSON.parse(localStorage.getItem(`task-tracker:persistence-v1:workspace:${id}`) ?? '{"drafts":[],"operations":[]}'), actor);
  const editor = () => page.locator(".task-drawer[role=dialog]");
  async function openEditor() {
    if (await editor().isVisible()) return;
    const resume = page.getByRole("button", { name: "חזרה לעריכה", exact: true });
    if (await resume.count()) { await resume.first().click(); return; }
    const first = page.locator(".task-card").first();
    await first.locator(".task-edit-button").click();
    await editor().waitFor();
  }
  async function save() {
    const button = editor().getByRole("button", { name: /^(שמירת שינויים|יצירת משימה|שמירת סטטוס צעדים)$/ });
    if (await button.count() && await button.isEnabled()) {
      const before = sent.length;
      await button.click();
      await until(async () => sent.length > before || Boolean(await page.locator(".editor-error").count()), "No save request");
    }
  }
  async function release({ timeout = false, rejection = false } = {}) {
    const pending = queued.shift(); if (!pending) return;
    let result;
    if (pending.forcedStatus) result = { status: pending.forcedStatus, operationId: pending.value.operationId };
    else if (rejection) result = { status: "validation_failed", operationId: pending.value.operationId };
    else result = await h.send(pending.actor, pending.value);
    if (timeout) await pending.route.abort("timedout").catch(() => {});
    else await pending.route.fulfill({ status: ["committed", "prepared"].includes(result.status) ? 200 : 409, json: result }).catch(() => {});
    await until(async () => !(await editor().count()) || await editor().locator('[data-save-state="submitting"]').count() === 0 || await page.getByRole("dialog", { name: /^בדיקת שינויים/ }).count() > 0);
  }
  async function poll() {
    const before = reads;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await until(() => reads > before);
    await page.waitForTimeout(100);
  }
  async function switchAccount(id) {
    actor = id;
    await h.admin("update persistence_v1.accounts set enabled=true,read_only=false where user_id=$1", [actor]);
    await page.evaluate((value) => { localStorage.setItem("sb-synthetic-auth-token", JSON.stringify(value)); }, session(actor));
    await page.reload({ waitUntil: "networkidle" });
    await until(async () => !(await page.getByLabel("טוען את האפליקציה").count()));
  }
  async function closeEditor() {
    if (await editor().count()) await editor().getByRole("button", { name: "סגירת חלונית משימה" }).click();
    const close = page.getByRole("dialog", { name: "סגירת העריכה" });
    if (await close.count()) {
      const keep = close.getByRole("button", { name: "שמירת טיוטה וסגירה", exact: true });
      if (await keep.isEnabled()) await keep.click();
    }
  }
  async function event(name, value = {}) {
    if (name === "edit") {
      await openEditor();
      if (value.title !== undefined && await editor().getByLabel("שם משימה", { exact: true }).isEnabled()) await editor().getByLabel("שם משימה", { exact: true }).fill(value.title);
      if (value.notes !== undefined) {
        const notes = editor().locator("textarea");
        if (await notes.isEnabled()) await notes.fill(value.notes ?? "");
        else await editor().getByRole("combobox").last().selectOption("done");
      }
      await page.waitForTimeout(60); return;
    }
    if (name === "save") return save();
    if (name === "hold_response") return;
    if (name === "transport_timeout") { await release({ timeout: true }); await page.locator('[data-save-state="unknown"]').waitFor(); return; }
    if (name === "committed_response") {
      await release();
      const statusDialog = page.getByRole("dialog", { name: "שמירה וטיוטות", exact: true });
      if (await statusDialog.count()) {
        await statusDialog.getByRole("button", { name: "סגירה", exact: true }).click();
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow === "hidden"), false, "Closing all overlays restores scrolling");
      }
      return;
    }
    if (name === "check_status") {
      await closeEditor();
      await page.getByRole("region", { name: "מצב שמירה" }).getByRole("button", { name: "הצג", exact: true }).click();
      await page.getByRole("button", { name: "בדיקת מצב", exact: true }).first().click();
      await until(async () => (await workspace()).operations.some((op) => op.status === "committed")); return;
    }
    if (name === "offline" || name === "online") {
      await page.evaluate((connected) => { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => connected }); window.dispatchEvent(new Event(connected ? "online" : "offline")); }, name === "online");
      return;
    }
    if (name === "poll" || name === "focus") return poll();
    if (name === "reload") {
      await page.reload({ waitUntil: "networkidle" });
      if ((await workspace()).drafts.length) {
        await page.getByRole("region", { name: "מצב שמירה" }).getByRole("button", { name: "הצג", exact: true }).click();
        await page.getByRole("button", { name: "חזרה לעריכה", exact: true }).first().click();
      }
      return;
    }
    if (name === "conflict_response") {
      const row = value.current;
      await h.admin("update public.tasks set title=$2,notes=$3,subtasks=$4::jsonb,revision=$5::bigint where id=$1", [row.id, row.title, row.notes, JSON.stringify(row.subtasks ?? []), row.revision]);
      if (!queued.length) {
        const compare = page.getByRole("button", { name: "השוואת שינויים", exact: true });
        if (await compare.count()) { await compare.click(); await page.getByRole("dialog", { name: /^בדיקת שינויים/ }).waitFor(); return; }
        await save();
      }
      await release();
      await page.getByRole("dialog", { name: /^בדיקת שינויים/ }).waitFor(); return;
    }
    if (name === "choose_local") { await page.locator(`[data-diff-field="${value.field}"]`).getByRole("radio").last().check(); return; }
    if (name === "confirm_resolution") { await page.getByRole("button", { name: "אישור ושמירת הבחירה", exact: true }).click(); await until(() => queued.length > 0); return; }
    if (name === "server_snapshot") { readOverride = { ...value }; await poll(); return; }
    if (name === "storage_failure") { await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Synthetic quota", "QuotaExceededError"); }; }); return; }
    if (name === "close_requested") { await editor().getByRole("button", { name: "סגירת חלונית משימה" }).click(); return; }
    if (name === "session_expired") {
      await page.evaluate(() => localStorage.setItem("sb-synthetic-auth-token", "null"));
      await page.reload({ waitUntil: "networkidle" }); await page.locator(".auth-gate").waitFor(); return;
    }
    if (name === "switch_account") return switchAccount(value.actor);
    if (name === "old_account_response") { while (queued.length) await release(); return; }
    if (name === "open_shared_assignment") { await h.fixture("accepted_assignment", { taskId: seed.tasks[0].id, subtaskId: "step-1-1" }); await switchAccount(seed.recipient); await openEditor(); return; }
    if (name === "access_revoked") { await h.fixture("revoke_access", { taskId: seed.tasks[0].id }); await poll(); await until(async () => await editor().count() === 0); return; }
    if (name === "new_task") {
      // The Next development toolbar is not part of the product and covers the floating add button.
      await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => { node.style.display = "none"; }));
      await page.getByRole("button", { name: "הוספת משימה חדשה", exact: true }).click(); await editor().locator(".edit-grid select").first().selectOption("Synthetic topic"); return;
    }
    if (["read_only", "upgrade_required", "stale_epoch"].includes(name)) {
      if (name === "read_only") await h.admin("update persistence_v1.accounts set read_only=true where user_id=$1", [actor]);
      if (name === "stale_epoch") await h.admin("update persistence_v1.accounts set write_epoch=write_epoch+1 where user_id=$1", [actor]);
      if (name === "upgrade_required") forcedStatus = "client_upgrade_required";
      await save(); await release(); return;
    }
    if (name === "reset_synthetic_view") {
      forcedStatus = null; readOverride = null;
      await h.admin("update persistence_v1.accounts set read_only=false,write_epoch=1 where user_id=$1", [actor]);
      await page.evaluate((id) => { for (const key of Object.keys(localStorage)) if (key.startsWith(`task-tracker:persistence-v1:workspace:${id}`) || key.startsWith(`task-tracker:persistence-v1:operation:${id}:`)) localStorage.removeItem(key); }, actor);
      await page.reload({ waitUntil: "networkidle" }); return;
    }
    if (name === "ai_proposal") {
      await h.fixture("proposal", { taskId: seed.tasks[0].id, action: { type: "update_task_status", taskId: "P1", status: "waiting", label: "Synthetic proposal" } });
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: "פתיחת שיחת AI", exact: true }).click(); return;
    }
    if (name === "approve_ai") {
      const approve = page.getByRole("button", { name: "אישור וביצוע: Synthetic proposal", exact: true });
      if (await approve.count()) {
        await approve.click();
        await page.getByRole("dialog", { name: "אישור שינוי שהציע AI", exact: true }).getByRole("button", { name: "אישור וביצוע", exact: true }).click();
        await until(() => queued.length > 0);
      }
      return;
    }
    if (name === "proposal_already_committed") {
      const pending = queued[0];
      assert.ok(pending);
      await h.send(actor, { ...pending.value, operationId: command().operationId });
      await release();
      await until(async () => await page.locator(".assistant-action-flow.status-done").count() === 1); return;
    }
    if (name === "bulk_preview") {
      const modal = page.locator(".persistence-dialog");
      if (await modal.count()) await modal.getByRole("button", { name: "סגירה", exact: true }).click();
      if (!await page.locator(".settings-drawer").count()) await page.getByRole("button", { name: "פתיחת הגדרות", exact: true }).click();
      if (value.kind === "import") {
        await page.getByRole("button", { name: /חיבור.*סנכרון/ }).click();
        const rows = seed.tasks.map((row) => ({ ...row, id: `${row.prefix}${row.number}`, cloudId: row.id, ownerUserId: seed.owner, subtasks: [], title: "Synthetic imported title" }));
        await page.locator('input[type="file"]').setInputFiles({ name: "synthetic-import.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ tasks: rows })) });
        await page.getByRole("dialog", { name: /^בדיקת ייבוא/ }).getByRole("checkbox").first().waitFor();
        for (const checkbox of await page.getByRole("dialog", { name: /^בדיקת ייבוא/ }).getByRole("checkbox").all()) await checkbox.check();
      } else {
        await page.getByRole("button", { name: "נושאים ופעולות", exact: true }).click();
        await page.getByRole("button", { name: "עריכת נושא Synthetic topic", exact: true }).first().click();
        await page.locator(".settings-drawer").getByLabel("שם נושא חדש", { exact: true }).first().fill("Synthetic renamed");
        await page.locator(".settings-drawer").getByRole("button", { name: "שמירה", exact: true }).click();
      }
      return;
    }
    if (name === "confirm_bulk") {
      const importButton = page.getByRole("button", { name: "אישור וייבוא הבחירה", exact: true });
      if (await importButton.count()) await importButton.click();
      else await page.getByRole("dialog", { name: "אישור שינוי נושא", exact: true }).getByRole("button", { name: "אישור וביצוע", exact: true }).click();
      await until(() => queued.length > 0); return;
    }
    if (name === "bulk_rejected") { await release({ rejection: true }); await until(async () => (await workspace()).operations.at(-1)?.status === "validation_failed"); return; }
    if (name === "seed_cached_list") return;
    if (name === "partial_list") { partial = true; await poll(); return; }
    if (name === "render") {
      await page.setViewportSize(value.viewport);
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, value.theme);
      if (await page.getByRole("dialog", { name: /^בדיקת שינויים/ }).count()) await page.getByRole("dialog", { name: /^בדיקת שינויים/ }).getByRole("button", { name: "סגירה", exact: true }).click();
      return;
    }
    if (name === "open_conflict") {
      await event("edit", { title: "Synthetic display draft" });
      const current = await h.read(actor, seed.tasks[0].id);
      return event("conflict_response", { current: { ...current, revision: String(BigInt(current.revision) + 1n) } });
    }
    if (name === "keyboard_viewport") { await page.setViewportSize({ width: page.viewportSize().width, height: value.height }); await page.getByRole("dialog", { name: /^בדיקת שינויים/ }).getByRole("radio").first().focus(); return; }
    throw new Error(`Unimplemented rendered event: ${name}`);
  }
  async function view() {
    const stored = await workspace();
    const state = await page.evaluate(() => {
      const editor = document.querySelector(".task-drawer"), status = editor?.querySelector("[data-save-state]")?.getAttribute("data-save-state");
      const card = document.querySelector(".task-card");
      const diff = {};
      for (const field of document.querySelectorAll("[data-diff-field]")) {
        const values = [...field.querySelectorAll(".persistence-diff-values p")].map((p) => p.textContent === "ריק / הוסר" ? null : p.textContent);
        const choices = field.querySelectorAll('input[type="radio"]');
        diff[field.getAttribute("data-diff-field")] = { base: values[0], server: values[1], local: values[2], selection: choices[1]?.checked ? "local" : "server", canRestoreRemovedIdentity: !choices[1]?.disabled };
      }
      return { status, task: card ? { revision: card.getAttribute("data-task-revision") } : null,
        canSave: Boolean(editor?.querySelector('button[type="submit"]:not(:disabled)')),
        storageWarning: document.body.textContent.includes("הטיוטה קיימת כרגע במסך בלבד") || document.body.textContent.includes("הטיוטה קיימת במסך בלבד"),
        closeWarning: [...document.querySelectorAll('[role="dialog"]')].some((node) => node.getAttribute("aria-label") === "סגירת העריכה"),
        diff, confirmationValid: Object.values(diff).some((row) => row.selection === "local"),
        partialListWarning: document.body.textContent.includes("מוצגות רק חלק מהמשימות"),
        cachedTasks: [...document.querySelectorAll(".task-card")].map((node) => ({ id: node.getAttribute("data-task-uuid") })),
        canExportDraft: Boolean(document.querySelector('[aria-label="ייצוא טיוטה"]')),
        finalDisplayId: editor?.getAttribute("aria-label") === "משימה חדשה" ? null : document.querySelector(".task-editor-id strong")?.textContent ?? null,
        partialSuccessCount: [...document.querySelectorAll(".import-message")].filter((node) => /הייבוא נשמר בענן/.test(node.textContent)).length,
      };
    });
    const last = stored.operations.at(-1);
    let draft = stored.drafts.at(-1)?.draft ?? null;
    if (await editor().count()) draft = { ...(draft ?? {}), title: await editor().getByLabel("שם משימה", { exact: true }).inputValue(), notes: await editor().locator("textarea").inputValue() };
    return { ...state, status: state.status ?? (Object.keys(state.diff).length ? "conflict" : last?.status === "committed" ? "saved" : last?.status ?? "draft"),
      draft, localDurable: !state.storageWarning && Boolean(stored.drafts.length),
      savedIndicator: last?.status === "committed", sentCommands: sent.map((item) => item.kind === "import" && item.items?.length === 1 ? { ...item, ...item.items[0] } : item), activeCommand: sent.at(-1) ?? null,
      successAnnouncements: stored.operations.filter((op) => op.status === "committed").length,
    };
  }
  return { capabilities, event: async (...args) => { try { return await event(...args); } catch (error) { console.error(`Rendered event ${args[0]}: ${error.message.slice(0, 1200)}`); throw error; } }, view,
    async measure() {
      if (process.env.PERSISTENCE_QA_DIR) {
        const theme = await page.locator("html").getAttribute("data-theme"), size = page.viewportSize();
        await page.screenshot({ path: resolve(process.env.PERSISTENCE_QA_DIR, `persistence-6c-${size.width}-${size.height}-${theme}.png`) });
      }
      return page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => node.getAttribute("aria-label")?.startsWith("בדיקת שינויים"));
      const primary = dialog?.querySelector("footer button"), focused = document.activeElement;
      const visible = (node) => { const r = node?.getBoundingClientRect(); return Boolean(r && r.top >= 0 && r.bottom <= innerHeight + 1); };
      return { direction: getComputedStyle(dialog).direction, scrollWidth: document.documentElement.scrollWidth,
        minimumTouchTarget: Math.min(...[...dialog.querySelectorAll("button, label")].map((node) => node.getBoundingClientRect().height)),
        backgroundScrollLocked: getComputedStyle(document.body).overflow === "hidden", focusInsideDialog: dialog.contains(focused),
        statusAnnounced: Boolean(dialog.querySelector('[role="status"][aria-live="polite"]')), focusedInputVisible: visible(focused), primaryActionVisible: visible(primary) };
    }); },
    async close() { await context.close(); await browser.close(); assert.deepEqual(pageErrors, []); },
  };
  } catch (error) { await context.close(); await browser.close(); throw error; }
}
