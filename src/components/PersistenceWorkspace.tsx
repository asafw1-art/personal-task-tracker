"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, CircleAlert, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { persistenceServerSnapshot, persistenceSnapshot, persistenceStatusText, persistenceSubscribe, dismissPersistenceOperation, taskDiff, resolvedTask, sameValue, type DiffField, type TaskDraft, type TaskDraftRecord } from "@/lib/persistenceUx";
import { resolvePendingPersistence } from "@/lib/persistenceWriters";
import type { Task } from "@/lib/tasks";
import type { PersistenceReply } from "@/lib/persistenceTransport";

const scrollOwners = new Set<symbol>();
let restoreScroll: (() => void) | null = null;
export function lockPageScroll() {
  const owner = Symbol("overlay");
  if (!scrollOwners.size) {
    const scroll = window.scrollY;
    const { position, top, width, overflow } = document.body.style;
    document.documentElement.classList.add("modal-open");
    Object.assign(document.body.style, { position: "fixed", top: `-${scroll}px`, width: "100%", overflow: "hidden" });
    restoreScroll = () => {
      document.documentElement.classList.remove("modal-open");
      Object.assign(document.body.style, { position, top, width, overflow }); window.scrollTo(0, scroll);
    };
  }
  scrollOwners.add(owner);
  return () => { scrollOwners.delete(owner); if (!scrollOwners.size) { restoreScroll?.(); restoreScroll = null; } };
}

export function PersistenceDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const unlock = lockPageScroll();
    const dialog = ref.current;
    dialog?.focus();
    const viewport = window.visualViewport;
    const resize = () => {
      dialog?.style.setProperty("--persistence-height", `${viewport?.height ?? window.innerHeight}px`);
      dialog?.style.setProperty("--persistence-top", `${viewport?.offsetTop ?? 0}px`);
      if (dialog?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.scrollIntoView?.({ block: "nearest" });
    };
    resize(); viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize);
      unlock();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return <div className="persistence-backdrop"><section ref={ref} className="persistence-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} dir="rtl"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((node) => node.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
    }}>
    <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="סגירה" title="סגירה"><X size={20} aria-hidden="true" /></button></header>
    {children}
  </section></div>;
}

export function PersistenceWorkspace({ userId, onResume, onResolved, onRefresh }: { userId: string; onResume: (draft: TaskDraftRecord) => void; onResolved: (reply: PersistenceReply) => Promise<void>; onRefresh: () => Promise<void> }) {
  const state = useSyncExternalStore(persistenceSubscribe, () => persistenceSnapshot(userId), persistenceServerSnapshot);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = state.operations.filter((op) => !["committed", "prepared"].includes(op.status));
  const last = state.operations.at(-1);
  async function check(operationId: string, retry: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try { const reply = await resolvePendingPersistence(userId, retry, operationId); if (reply) await onResolved(reply); }
    catch { setError("לא ניתן להשלים את הבדיקה כרגע. מזהה הפעולה נשמר; אין ליצור פעולה חדשה במקומה."); }
    finally { setBusy(false); }
  }
  if (!state.drafts.length && !pending.length && !last && !state.partial && !state.storageWarning) return null;
  return <section className="persistence-workspace" aria-label="מצב שמירה">
    <div className="persistence-status" role="status" aria-live="polite" aria-atomic="true">
      {last?.status === "submitting" ? <LoaderCircle size={18} aria-hidden="true" /> : pending.length ? <CircleAlert size={18} aria-hidden="true" /> : <Save size={18} aria-hidden="true" />}
      <span>{last && ["submitting", "checking"].includes(last.status) ? persistenceStatusText(last.status) : pending.length ? `${pending.length} פעולות דורשות בדיקה` : last ? persistenceStatusText(last.status) : `${state.drafts.length} טיוטות שלא נשלחו`}</span>
      <button type="button" onClick={() => setOpen(true)}>הצג</button>
    </div>
    {state.partial && <p role="status">{persistenceStatusText("restart_required")} <button type="button" onClick={() => void onRefresh().catch(() => setError("טעינת הרשימה נכשלה."))}><RefreshCw size={16} />טעינה חוזרת</button></p>}
    {state.storageWarning && <p role="alert">הטיוטה קיימת כרגע במסך בלבד. סגירה או רענון עלולים לאבד אותה.</p>}
    {error && <p role="alert">{error}</p>}
    {open && <PersistenceDialog title="שמירה וטיוטות" onClose={() => setOpen(false)}>
      <div className="persistence-dialog-content">
        <h3>תוצאות ופעולות הדורשות טיפול</h3>
        {!state.operations.length && <p>אין פעולות שנשלחו.</p>}
        {state.operations.map((op) => <article className="persistence-operation" key={op.operationId}>
          <strong>{persistenceStatusText(op.status)}</strong><code dir="ltr">{op.operationId}</code>
          {["unknown", "authentication_required", "checking"].includes(op.status) ? <div className="persistence-buttons">
            <button type="button" disabled={busy} onClick={() => void check(op.operationId, false)}><RefreshCw size={17} />בדיקת מצב</button>
            <button type="button" disabled={busy} onClick={() => void check(op.operationId, true)}>בדיקה ושליחה בטוחה של אותה פעולה</button>
            {op.status === "authentication_required" && <button type="button" onClick={() => dismissPersistenceOperation(userId, op.operationId)}>סגירת החיווי לאחר התחברות מחדש</button>}
          </div> : !["submitting"].includes(op.status) && <button type="button" onClick={() => dismissPersistenceOperation(userId, op.operationId)}>סגירת החיווי</button>}
        </article>)}
        <h3>טיוטות שלא נשלחו</h3>
        {!state.drafts.length && <p>אין טיוטות במכשיר הזה.</p>}
        {state.drafts.map((draft) => <article className="persistence-operation" key={draft.key}><strong>{draft.base?.sharedWithMe ? "טיוטת משימה משותפת — נדרש אימות גישה" : draft.base?.id ?? "משימה חדשה — טיוטה"}</strong>{!draft.base?.sharedWithMe && <span>{draft.draft.title || "ללא כותרת"}</span>}
          <button type="button" onClick={() => { setOpen(false); onResume(draft); }}>חזרה לעריכה</button></article>)}
      </div>
    </PersistenceDialog>}
  </section>;
}

const fieldLabels: Record<DiffField, string> = { title: "שם משימה", category: "נושא", actionType: "פעולה", priority: "עדיפות", status: "סטטוס", dueDate: "תאריך יעד", notes: "הערות", subtasks: "צעדי טיפול" };
const valueLabels: Record<string, string> = { open: "פתוחה", in_progress: "בטיפול", waiting: "ממתינה", done: "בוצעה", cancelled: "בוטלה", high: "גבוהה", important: "חשובה", normal: "רגילה", low: "נמוכה" };
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "ריק / הוסר";
  if (Array.isArray(value)) return value.map((step) => `${step.number}. ${step.title || "ללא תיאור"} · ${valueLabels[step.status] ?? step.status}${step.actionType ? ` · ${step.actionType}` : ""}`).join("\n");
  return valueLabels[String(value)] ?? String(value);
}
export function PersistenceDiff({ base, server, draft, busy, onCancel, onConfirm, onDiscard }: { base: Task; server: Task; draft: TaskDraft; busy: boolean; onCancel: () => void; onConfirm: (next: Task) => void; onDiscard: () => void }) {
  const [selected, setSelected] = useState<Set<DiffField>>(new Set());
  const rows = taskDiff(base, server, draft);
  return <PersistenceDialog title={`בדיקת שינויים ב־${server.id}`} onClose={onCancel}>
    <div className="persistence-dialog-content">
      <p role="status" aria-live="polite">המידע בענן השתנה. בחר מה לשמור; לא נדרוס שינויים בלי אישורך.</p>
      {base.writeEpoch !== server.writeEpoch && <p role="alert">הנתונים הוחלפו מאז העריכה. אפשר לבחון את הכוונה מחדש, לא לשחזר זהויות ישנות.</p>}
      {rows.map((row) => <fieldset className="persistence-diff-field" data-diff-field={row.field} key={row.field}><legend>{fieldLabels[row.field]}</legend>
        <div className="persistence-diff-values">{[["לפני העריכה", row.base], ["כעת בענן", row.server], ["השינוי שלך", row.local]].map(([label, value]) => <div key={String(label)}><strong>{String(label)}</strong><p dir="auto">{displayValue(value)}</p></div>)}</div>
        {!row.selectable && <p>צעד הוסר או שהרשאות העריכה השתנו. אין לשחזר את הזהות הישנה; יש לחזור לעריכה וליצור צעד חדש במידת הצורך.</p>}
        <label><input type="radio" name={`diff-${row.field}`} checked={!selected.has(row.field)} onChange={() => setSelected((before) => new Set([...before].filter((field) => field !== row.field)))} />השארת הערך בענן</label>
        <label><input type="radio" name={`diff-${row.field}`} disabled={!row.selectable || sameValue(row.local, row.server) || busy || row.field === "subtasks" && base.writeEpoch !== server.writeEpoch} checked={selected.has(row.field)} onChange={() => setSelected((before) => new Set(before).add(row.field))} />בחירת השינוי שלי — {fieldLabels[row.field]}</label>
      </fieldset>)}
      <h3>אלה השינויים שיישמרו</h3>
      <ul>{[...selected].map((field) => <li key={field}>{fieldLabels[field]}: {displayValue(draft[field])}</li>)}</ul>
      {!selected.size && <p>לא נבחר שינוי. לא תתבצע כתיבה לענן.</p>}
      {selected.has("status") || selected.has("subtasks") ? <p>שינוי סטטוס או צעדים עשוי לעדכן גם את מצב השלמת המשימה ותאריך הסיום.</p> : null}
    </div>
    <footer><button type="button" disabled={busy || !selected.size} onClick={() => onConfirm(resolvedTask(server, draft, selected))}><Check size={18} />אישור ושמירת הבחירה</button>
      <button type="button" disabled={busy} onClick={onDiscard}>השארת הענן ומחיקת הטיוטה</button><button type="button" disabled={busy} onClick={onCancel}>חזרה לעריכה</button></footer>
  </PersistenceDialog>;
}
