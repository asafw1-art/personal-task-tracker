import { supabase } from "@/lib/supabase";
import type { Task, TaskSubtask } from "@/lib/tasks";
import { checkPersistenceOperation, fetchPersistenceBackup, fetchPersistenceContext, fetchPersistencePage, sendPersistenceCommand, type PersistenceCommand, type PersistenceReply } from "@/lib/persistenceTransport";

export const versionedPersistenceEnabled = process.env.NEXT_PUBLIC_PERSISTENCE_V1_ENABLED === "true";
type Context = PersistenceReply & { writeEpoch: string; settingsRevision: string; taxonomyRevision: string;
  settings: Record<string, unknown> | null; taxonomy: Record<string, unknown>[]; sharedTasks: Record<string, unknown>[]; shares: Record<string, unknown>[] };
const contexts = new Map<string, Context>();
const observedTasks = new Map<string, Task>();
const inFlight = new Set<string>();
const messageFor = (status: string) => ({ conflict: "הנתונים השתנו בענן. יש לרענן ולבחון את ההבדלים לפני אישור חדש.", unknown: "טרם התקבל אישור שמירה. הפעולה נשמרה לבירור; אין לשלוח פעולה חדשה.",
  stale_epoch: "בוצע שחזור או מעבר גרסה. יש לטעון מחדש לפני שמירה.", account_read_only: "החשבון במצב תחזוקה לקריאה בלבד.", authentication_required: "יש להתחבר מחדש לחשבון.",
  validation_failed: "הפעולה לא תקינה או מכילה נושא או פעולה שכבר אינם קיימים.", not_found_or_forbidden: "המשימה או הרשאת השיתוף אינן זמינות עוד.",
  client_upgrade_required: "נתיב השמירה החדש עדיין אינו זמין. לא בוצעה שמירה בנתיב הישן." } as Record<string, string>)[status] ?? "הפעולה לא נשמרה. יש לבדוק את מצב החיבור.";
export class PersistenceWriteError extends Error {
  constructor(readonly reply: PersistenceReply) { super(messageFor(reply.status)); }
}
async function assertActor(userId: string) {
  const session = await supabase?.auth.getSession();
  if (session?.error || session?.data.session?.user.id !== userId) throw new PersistenceWriteError({ status: "authentication_required" });
}
export function observedContext(userId: string): Context {
  const context = contexts.get(userId);
  if (!context) throw new PersistenceWriteError({ status: "client_upgrade_required" });
  return context;
}
export async function loadPersistenceContext(userId: string) {
  const reply = await fetchPersistenceContext(userId);
  await assertActor(userId);
  if (reply.status !== "context" || !reply.sharedComplete) throw new PersistenceWriteError(reply.status === "context" ? { status: "restart_required" } : reply);
  contexts.set(userId, reply as Context);
  return reply as Context;
}
export function snapshotToTask(value: Record<string, unknown>, userId: string, remember = true): Task {
  const { id, ...rest } = value;
  const task = { ...rest, id: value.ownerUserId && value.ownerUserId !== userId ? `shared:${id}` : `${value.prefix}${value.number}`, cloudId: id, ownerUserId: value.ownerUserId ?? userId,
    sharedWithMe: Boolean(value.ownerUserId && value.ownerUserId !== userId), actionType: value.actionType ?? undefined,
    notes: value.notes ?? undefined, dueDate: value.dueDate ?? undefined, completedAt: value.completedAt ?? undefined } as Task;
  if (remember) observedTasks.set(`${userId}:${id}`, structuredClone(task));
  return task;
}
export function observedTask(userId: string, cloudId: string) {
  const task = observedTasks.get(`${userId}:${cloudId}`);
  if (!task) throw new PersistenceWriteError({ status: "client_upgrade_required" });
  return structuredClone(task);
}
export async function loadVersionedTasks(userId: string) {
  const tasks: Record<string, unknown>[] = []; let cursor: Record<string, unknown> | null = null;
  do {
    const page = await fetchPersistencePage(userId, cursor);
    if (page.status !== "ok") throw new PersistenceWriteError(page);
    tasks.push(...(page.tasks as Record<string, unknown>[]));
    cursor = page.cursor as Record<string, unknown> | null;
  } while (cursor);
  const context = await loadPersistenceContext(userId);
  await assertActor(userId);
  return [...tasks, ...context.sharedTasks].map((row) => snapshotToTask(row, userId));
}
const journalPrefix = (userId: string) => `task-tracker:persistence-v1:operation:${userId}:`;
const pendingKeys = (userId: string) => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
  .filter((key): key is string => Boolean(key?.startsWith(journalPrefix(userId))));
export async function resolvePendingPersistence(userId: string, retrySameOperation = false) {
  const key = pendingKeys(userId)[0];
  const raw = key ? localStorage.getItem(key) : null;
  if (!raw) return null;
  const pending = JSON.parse(raw) as PersistenceCommand;
  let result = await checkPersistenceOperation(pending.operationId, userId);
  if (result.status === "unknown" && retrySameOperation) result = await sendPersistenceCommand(pending, userId);
  await assertActor(userId);
  if (["committed", "conflict", "not_found_or_forbidden", "idempotency_mismatch", "stale_epoch", "validation_failed", "prepared"].includes(result.status)) localStorage.removeItem(key);
  return result;
}
export async function currentPersistenceUser() {
  const session = await supabase?.auth.getSession();
  const user = session?.data.session?.user;
  if (!user) throw new PersistenceWriteError({ status: "authentication_required" });
  return user;
}
export async function exportVersionedAccount(userId: string) {
  const result = await fetchPersistenceBackup(userId);
  await assertActor(userId);
  if (result.status !== "backup") throw new PersistenceWriteError(result);
  return result.snapshot as Record<string, unknown>;
}
export function recoverySnapshotTasks(snapshot: Record<string, unknown>, userId: string) {
  const data = snapshot.data as Record<string, Record<string, unknown>[]>;
  const control = snapshot.persistence as { accounts: { write_epoch: string }[] };
  return data.tasks.map((row) => snapshotToTask({ id: row.id, prefix: row.prefix, number: row.task_number,
    title: row.title, category: row.category, actionType: row.action_type, priority: row.priority, status: row.status, notes: row.notes,
    dueDate: typeof row.due_at === "string" ? row.due_at.slice(0, 10) : undefined, completedAt: row.completed_at, createdAt: row.created_at,
    statusChangedAt: row.status_changed_at, focused: row.focused, subtasks: row.subtasks, revision: row.revision, writeEpoch: control.accounts[0].write_epoch }, userId, false));
}
export async function writeVersioned(userId: string, input: Omit<PersistenceCommand, "protocolVersion" | "operationId" | "expectedWriteEpoch"> & { expectedWriteEpoch?: string }) {
  await assertActor(userId);
  if (inFlight.has(userId) || pendingKeys(userId).length) throw new PersistenceWriteError({ status: "unknown" });
  const context = observedContext(userId);
  const command: PersistenceCommand = { ...input, protocolVersion: 1, operationId: crypto.randomUUID(), expectedWriteEpoch: input.expectedWriteEpoch ?? context.writeEpoch };
  const key = journalPrefix(userId) + command.operationId;
  // Refuse dispatch if the immutable operation cannot survive a reload.
  try { localStorage.setItem(key, JSON.stringify(command)); }
  catch { throw new Error("לא ניתן לשמור את מזהה הפעולה במכשיר. הפעולה לא נשלחה; שמור את הטיוטה לפני רענון."); }
  inFlight.add(userId);
  try {
    const result = await sendPersistenceCommand(command, userId);
    await assertActor(userId);
    if (result.status !== "unknown") localStorage.removeItem(key);
    if (!["committed", "prepared"].includes(result.status)) throw new PersistenceWriteError(result);
    if (result.task) snapshotToTask(result.task as Record<string, unknown>, userId);
    if (result.domain === "settings") context.settingsRevision = String(result.revision);
    if (result.domain === "taxonomy") context.taxonomyRevision = String(result.revision);
    return result;
  } finally { inFlight.delete(userId); }
}
export function taskCommandBase(task: Task) {
  if (!task.cloudId || !task.revision || !task.writeEpoch) throw new PersistenceWriteError({ status: "client_upgrade_required" });
  return { targetTaskUuid: task.cloudId, expectedRevision: task.revision, expectedWriteEpoch: task.writeEpoch };
}
export type AtomicItem = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function taskEditItems(base: Task | null, next: Pick<Task, "prefix" | "title" | "category" | "priority" | "status"> & Partial<Task>, items: AtomicItem[] = []) {
  if (base && (base.prefix !== next.prefix || (next.number !== undefined && base.number !== next.number)
    || (next.cloudId !== undefined && base.cloudId !== next.cloudId))) throw new PersistenceWriteError({ status: "validation_failed" });
  const start = items.length;
  let revision = BigInt(base?.revision ?? "1");
  let previousIndex: number | undefined = base ? undefined : start;
  const target = base ? { targetTaskUuid: base.cloudId } : { targetFrom: start };
  const append = (kind: string, fields: AtomicItem) => {
    items.push({ kind, ...target, expectedRevision: String(revision++), ...(previousIndex !== undefined ? { revisionFrom: previousIndex } : {}), ...fields });
    previousIndex = items.length - 1;
  };
  const patch: Record<string, unknown> = {};
  for (const key of ["title", "category", "actionType", "priority", "notes", "dueDate"] as const) {
    if (!base || !same(base[key], next[key])) patch[key] = next[key] ?? null;
  }
  if (!base) items.push({ kind: "create_task", patch: { ...patch, prefix: next.prefix } });
  else if (Object.keys(patch).length) append("patch_task", { patch });
  const before = base?.subtasks ?? [], after = next.subtasks ?? [];
  for (const step of before) if (!after.some((value) => value.id === step.id)) append("remove_subtask", { subtaskId: step.id });
  for (const step of after) {
    const previous = before.find((value) => value.id === step.id);
    if (!previous) {
      const index = items.length;
      append("add_subtask", { patch: { title: step.title, ...(step.actionType ? { actionType: step.actionType } : {}) } });
      if (step.status !== "open") append("set_subtask_status", { subtaskFrom: index, status: step.status });
    } else {
      const changes: Partial<TaskSubtask> = {};
      for (const key of ["title", "actionType"] as const) if (!same(previous[key], step[key])) Object.assign(changes, { [key]: step[key] ?? null });
      if (Object.keys(changes).length) append("patch_subtask", { subtaskId: step.id, patch: changes });
      if (previous.status !== step.status) append("set_subtask_status", { subtaskId: step.id, status: step.status });
    }
  }
  if (next.status !== (base?.status ?? "open")) append("set_task_status", { status: next.status });
  if (next.focused !== undefined && next.focused !== (base?.focused ?? false)) append("set_owner_focus", { focused: next.focused });
  return items;
}
