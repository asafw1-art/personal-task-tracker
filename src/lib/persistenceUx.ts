import type { Task, TaskSubtask } from "@/lib/tasks";
import type { PersistenceCommand, PersistenceReply } from "@/lib/persistenceTransport";

export type TaskDraft = Pick<Task, "prefix" | "title" | "category" | "priority" | "status"> & {
  actionType: string; dueDate: string; notes: string; subtasks: TaskSubtask[]; focused?: boolean;
};
export type TaskDraftRecord = { key: string; userId: string; base: Task | null; draft: TaskDraft };
export type OperationView = { operationId: string; kind: string; target?: string; status: string; reply?: PersistenceReply };
type UxSnapshot = { drafts: TaskDraftRecord[]; operations: OperationView[]; storageWarning: boolean; partial: boolean };
const empty: UxSnapshot = { drafts: [], operations: [], storageWarning: false, partial: false };
const snapshots = new Map<string, UxSnapshot>();
const listeners = new Set<() => void>();
const keyFor = (userId: string) => `task-tracker:persistence-v1:workspace:${userId}`;
export const operationPrefix = (userId: string) => `task-tracker:persistence-v1:operation:${userId}:`;
export const persistenceSubscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const persistenceSnapshot = (userId?: string) => userId ? snapshots.get(userId) ?? empty : empty;
export const persistenceServerSnapshot = () => empty;
function update(userId: string, patch: Partial<UxSnapshot>, persist = true) {
  const value = { ...persistenceSnapshot(userId), ...patch };
  if (persist) {
    try { localStorage.setItem(keyFor(userId), JSON.stringify({ drafts: value.drafts, operations: value.operations.filter((op) => op.status !== "submitting").slice(-30) })); }
    catch { value.storageWarning = true; }
  }
  snapshots.set(userId, value);
  for (const listener of listeners) listener();
}
export function hydratePersistenceWorkspace(userId: string) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    const drafts = Array.isArray(parsed.drafts) ? parsed.drafts.filter((row: TaskDraftRecord) => row.userId === userId && row.draft && typeof row.key === "string") : [];
    const operations: OperationView[] = Array.isArray(parsed.operations) ? parsed.operations.filter((op: OperationView) => typeof op.operationId === "string") : [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(operationPrefix(userId))) continue;
      const command = JSON.parse(localStorage.getItem(key) ?? "null") as PersistenceCommand | null;
      if (!command?.operationId || key !== operationPrefix(userId) + command.operationId) continue;
      const previous = operations.findIndex((op) => op.operationId === command.operationId);
      const op = { operationId: command.operationId, kind: command.kind, target: command.targetTaskUuid, status: "unknown" };
      if (previous >= 0) operations[previous] = op; else operations.push(op);
    }
    update(userId, { drafts, operations }, false);
  } catch { update(userId, { storageWarning: true }, false); }
}
export function recordPersistenceOperation(userId: string, command: PersistenceCommand, status: string, reply?: PersistenceReply) {
  const previous = persistenceSnapshot(userId);
  // Outcomes contain only technical metadata; task content stays in the authorized cache/draft.
  const safeReply = reply ? { status: reply.status, operationId: reply.operationId, domain: reply.domain } : undefined;
  const op: OperationView = { operationId: command.operationId, kind: command.kind, target: command.targetTaskUuid, status, reply: safeReply };
  update(userId, { operations: [...previous.operations.filter((row) => row.operationId !== op.operationId), op].slice(-30) });
}
export function dismissPersistenceOperation(userId: string, operationId: string) {
  update(userId, { operations: persistenceSnapshot(userId).operations.filter((op) => op.operationId !== operationId) });
}
export function draftKey(base: Task | null) { return base ? `${base.cloudId}:${base.writeEpoch}:${base.revision}` : "new"; }
export function storeTaskDraft(userId: string, base: Task | null, draft: TaskDraft) {
  const key = draftKey(base);
  const row = { key, userId, base: base ? structuredClone(base) : null, draft: structuredClone(draft) };
  const current = persistenceSnapshot(userId);
  // Retain just one editable intention per target, not an unbounded offline history.
  update(userId, { storageWarning: false, drafts: [...current.drafts.filter((item) => item.key !== key && (!base || item.base?.cloudId !== base.cloudId)), row] });
  return !persistenceSnapshot(userId).storageWarning;
}
export function removeTaskDraft(userId: string, key: string) {
  const target = key.split(":")[0];
  update(userId, { drafts: persistenceSnapshot(userId).drafts.filter((row) => row.key !== key && row.base?.cloudId !== target) });
}
export function reconcileDraftAccess(userId: string, tasks: Task[]) {
  const current = persistenceSnapshot(userId);
  const drafts = current.drafts.filter((row) => !row.base?.sharedWithMe || tasks.some((task) => task.cloudId === row.base?.cloudId && task.sharedWithMe));
  if (drafts.length !== current.drafts.length) update(userId, { drafts });
}
export function setPersistencePartial(userId: string, partial: boolean) { update(userId, { partial }, false); }

export const persistenceStatusText = (status: string) => ({
  draft: "טיוטה — טרם נשמרה בענן", submitting: "שומר בענן…", checking: "בודק אם השינוי נשמר…", committed: "נשמר בענן",
  prepared: "ההצעה מוכנה לאישור; השינוי טרם בוצע", unknown: "טרם התקבל אישור שמירה. ייתכן שהשינוי כבר נשמר.",
  conflict: "המשימה השתנתה מאז פתיחת העריכה. השינוי שלך לא הוחל.", stale_epoch: "הנתונים הוחלפו מאז העריכה. נדרשת בדיקה מחדש.",
  account_read_only: "השמירה מושבתת זמנית. אפשר לצפות ולהכין טיוטה.", client_upgrade_required: "נדרש עדכון כדי לשמור שינויים.",
  authentication_required: "נדרשת התחברות מחדש כדי לבדוק או לשמור שינויים.", not_found_or_forbidden: "אין עוד גישה למשימה או לפעולה. לא ניתן להחיל את השינוי.",
  validation_failed: "השינוי לא נשמר. יש לבדוק את הפרטים וההרשאות.", idempotency_mismatch: "מזהה הפעולה אינו תואם. אין לשלוח שוב; יש לפנות לתמיכה.",
  restart_required: "מוצגות רק חלק מהמשימות. הרשימה הקודמת נשמרה; יש לטעון מחדש.",
} as Record<string, string>)[status] ?? "השינוי לא נשמר. נדרש בירור.";

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const editableFields = ["title", "category", "actionType", "priority", "status", "dueDate", "notes", "subtasks"] as const;
export type DiffField = typeof editableFields[number];
export type DiffRow = { field: DiffField; base: unknown; server: unknown; local: unknown; selectable: boolean };
export function taskDiff(base: Task, server: Task, draft: TaskDraft): DiffRow[] {
  return editableFields.flatMap((field) => {
    const value = (source: Task | TaskDraft) => field === "subtasks" ? (source.subtasks ?? []).map(({ id, number, title, status, actionType }) => ({ id, number, title, status, actionType: actionType || null })) : source[field] || null;
    const before = value(base), remote = value(server), local = value(draft);
    if (sameValue(before, remote) && sameValue(before, local)) return [];
    const removedIdentity = field === "subtasks" && (base.subtasks ?? []).some((step) => !(server.subtasks ?? []).some((row) => row.id === step.id));
    return [{ field, base: before, server: remote, local, selectable: !removedIdentity && !server.sharedWithMe }];
  });
}
export function resolvedTask(server: Task, draft: TaskDraft, chosen: Set<DiffField>): Task {
  const next = structuredClone(server);
  for (const field of editableFields) if (chosen.has(field)) {
    const value = draft[field];
    Object.assign(next, { [field]: ["dueDate", "actionType", "notes"].includes(field) && !value ? undefined : structuredClone(value) });
  }
  return next;
}
export function newerTask(previous: Task | undefined, incoming: Task): Task {
  if (!previous?.revision || !incoming.revision || !previous.writeEpoch || !incoming.writeEpoch) return incoming;
  const oldEpoch = BigInt(previous.writeEpoch), nextEpoch = BigInt(incoming.writeEpoch);
  return nextEpoch < oldEpoch || (nextEpoch === oldEpoch && BigInt(incoming.revision) < BigInt(previous.revision)) ? previous : incoming;
}
export function describePersistenceCommand(command: Record<string, unknown>): string[] {
  const names: Record<string, string> = { create_task: "יצירת משימה חדשה — מספר יוקצה בשרת", patch_task: "עדכון פרטי משימה", set_task_status: "שינוי סטטוס משימה", set_owner_focus: "שינוי מיקוד", add_subtask: "יצירת צעד חדש — מספר יוקצה בשרת", patch_subtask: "עדכון צעד", remove_subtask: "מחיקת צעד לצמיתות; המספר לא ימוחזר", set_subtask_status: "שינוי סטטוס צעד" };
  const fields: Record<string, string> = { title: "שם", category: "נושא", actionType: "פעולה", priority: "עדיפות", notes: "הערות", dueDate: "תאריך יעד", prefix: "סוג" };
  const values: Record<string, string> = { open: "פתוחה", in_progress: "בטיפול", waiting: "ממתינה", done: "בוצעה", cancelled: "בוטלה", high: "גבוהה", important: "חשובה", normal: "רגילה", low: "נמוכה" };
  const lines = [names[String(command.kind)] ?? "שינוי שאושר בהצעה"];
  if (command.targetTaskUuid) lines.push(`זהות המשימה: ${command.targetTaskUuid}`);
  if (command.expectedRevision) lines.push(`גרסת בסיס: ${command.expectedRevision}`);
  if (command.subtaskId) lines.push(`זהות הצעד: ${command.subtaskId}`);
  const patch = command.patch as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(patch ?? {})) lines.push(`${fields[key] ?? key}: ${value === null || value === "" ? "ריק / הוסר" : values[String(value)] ?? String(value)}`);
  if (command.status) lines.push(`סטטוס: ${values[String(command.status)] ?? command.status}`);
  if (command.focused !== undefined) lines.push(command.focused ? "הוספה למיקוד" : "הסרה ממיקוד");
  if (command.kind === "set_task_status" || command.kind === "set_subtask_status" || command.kind === "remove_subtask") lines.push("מצב ההשלמה ותאריך הסיום עשויים להתעדכן בהתאם לצעדים.");
  return lines;
}
