import type { User } from "@supabase/supabase-js";
import { Task, TaskPrefix, TaskPriority, TaskStatus, TaskSubtask, TaskSubtaskStatus } from "@/lib/tasks";
import { supabase } from "@/lib/supabase";

type TaskRow = {
  id?: string;
  user_id?: string;
  prefix: TaskPrefix;
  task_number: number;
  title: string;
  category: string;
  action_type?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  notes: string | null;
  due_at: string | null;
  completed_at: string | null;
  status_changed_at?: string | null;
  subtasks?: unknown;
  focused?: boolean | null;
  created_at: string;
};

type OptionalColumns = {
  actionType: boolean;
  statusChangedAt: boolean;
  subtasks: boolean;
  focused: boolean;
};

const selectAttempts: { columns: string; optional: OptionalColumns }[] = [
  {
    columns: "id, user_id, prefix, task_number, title, category, action_type, priority, status, notes, due_at, completed_at, status_changed_at, subtasks, focused, created_at",
    optional: { actionType: true, statusChangedAt: true, subtasks: true, focused: true },
  },
  {
    columns: "id, user_id, prefix, task_number, title, category, action_type, priority, status, notes, due_at, completed_at, status_changed_at, subtasks, created_at",
    optional: { actionType: true, statusChangedAt: true, subtasks: true, focused: false },
  },
  {
    columns: "id, user_id, prefix, task_number, title, category, action_type, priority, status, notes, due_at, completed_at, status_changed_at, created_at",
    optional: { actionType: true, statusChangedAt: true, subtasks: false, focused: false },
  },
  {
    columns: "id, user_id, prefix, task_number, title, category, action_type, priority, status, notes, due_at, completed_at, created_at",
    optional: { actionType: true, statusChangedAt: false, subtasks: false, focused: false },
  },
  {
    columns: "id, user_id, prefix, task_number, title, category, priority, status, notes, due_at, completed_at, created_at",
    optional: { actionType: false, statusChangedAt: false, subtasks: false, focused: false },
  },
];

const upsertAttempts: OptionalColumns[] = [
  { actionType: true, statusChangedAt: true, subtasks: true, focused: true },
  { actionType: true, statusChangedAt: true, subtasks: true, focused: false },
  { actionType: true, statusChangedAt: true, subtasks: false, focused: false },
  { actionType: true, statusChangedAt: false, subtasks: false, focused: false },
  { actionType: false, statusChangedAt: false, subtasks: false, focused: false },
];

function dateOnly(value: string | null | undefined) {
  return value ? value.slice(0, 10) : undefined;
}

function toTimestamp(value: string | undefined) {
  if (!value) return null;
  if (!value.includes("T")) return `${value}T12:00:00.000Z`;
  return new Date(value).toISOString();
}

function isTaskSubtaskStatus(value: unknown): value is TaskSubtaskStatus {
  return value === "open" || value === "done" || value === "cancelled";
}

function normalizeSubtasks(value: unknown): TaskSubtask[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const subtask = item as Record<string, unknown>;
      const number = Number(subtask.number);
      if (!Number.isInteger(number) || number <= 0) return null;
      if (typeof subtask.id !== "string" || !subtask.id.trim()) return null;
      if (typeof subtask.title !== "string" || !subtask.title.trim()) return null;
      if (!isTaskSubtaskStatus(subtask.status)) return null;

      const normalized: TaskSubtask = {
        id: subtask.id.trim(),
        number,
        title: subtask.title.trim(),
        status: subtask.status,
      };

      if (typeof subtask.actionType === "string" && subtask.actionType.trim()) normalized.actionType = subtask.actionType.trim();
      if (typeof subtask.createdAt === "string") normalized.createdAt = subtask.createdAt;
      if (typeof subtask.statusChangedAt === "string") normalized.statusChangedAt = subtask.statusChangedAt;
      return normalized;
    })
    .filter((subtask): subtask is TaskSubtask => Boolean(subtask))
    .sort((a, b) => a.number - b.number);
}

function rowToTask(row: TaskRow, currentUserId?: string): Task {
  const ownerUserId = row.user_id;
  const sharedWithMe = Boolean(currentUserId && ownerUserId && ownerUserId !== currentUserId);
  return {
    id: sharedWithMe && row.id ? `shared:${row.id}` : `${row.prefix}${row.task_number}`,
    cloudId: row.id,
    ownerUserId,
    sharedWithMe,
    prefix: row.prefix,
    number: row.task_number,
    title: row.title,
    category: row.category,
    actionType: row.action_type ?? undefined,
    priority: row.priority,
    status: row.status,
    notes: row.notes ?? undefined,
    dueDate: dateOnly(row.due_at),
    completedAt: dateOnly(row.completed_at),
    statusChangedAt: row.status_changed_at ?? undefined,
    subtasks: normalizeSubtasks(row.subtasks),
    focused: row.focused ?? undefined,
    createdAt: dateOnly(row.created_at),
  };
}

function taskToUpsert(task: Task, user: User, optional: OptionalColumns) {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    user_id: user.id,
    prefix: task.prefix,
    task_number: task.number,
    title: task.title,
    category: task.category,
    priority: task.priority,
    status: task.status,
    notes: task.notes ?? null,
    due_at: toTimestamp(task.dueDate),
    completed_at: toTimestamp(task.completedAt),
    created_at: toTimestamp(task.createdAt) ?? now,
    updated_at: now,
  };

  if (optional.actionType) row.action_type = task.actionType ?? null;
  if (optional.statusChangedAt) row.status_changed_at = toTimestamp(task.statusChangedAt);
  if (optional.subtasks) row.subtasks = task.subtasks ?? [];
  if (optional.focused) row.focused = task.focused ?? false;

  return row;
}

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

export async function fetchCloudTasks(user?: User) {
  const client = requireSupabase();
  let lastError: unknown;

  for (const attempt of selectAttempts) {
    const { data, error } = await client
      .from("tasks")
      .select(attempt.columns)
      .order("prefix", { ascending: true })
      .order("task_number", { ascending: true });

    if (!error) return (data ?? []).map((row) => rowToTask(row as unknown as TaskRow, user?.id));
    lastError = error;
    if (!isOptionalColumnError(error)) throw error;
  }

  throw lastError;
}

export async function countCloudTasks() {
  const client = requireSupabase();
  const { count, error } = await client
    .from("tasks")
    .select("task_number", { count: "exact", head: true });

  if (error) throw error;
  return count ?? 0;
}

export async function saveCloudTasks(tasks: Task[], user: User) {
  const ownTasks = tasks.filter((task) => !task.sharedWithMe && (!task.ownerUserId || task.ownerUserId === user.id));
  if (ownTasks.length === 0) return;
  const client = requireSupabase();
  let lastError: unknown;

  for (const optional of upsertAttempts) {
    const { error } = await client
      .from("tasks")
      .upsert(ownTasks.map((task) => taskToUpsert(task, user, optional)), {
        onConflict: "user_id,prefix,task_number",
      });

    if (!error) return;
    lastError = error;
    if (!isOptionalColumnError(error)) throw error;
  }

  throw lastError;
}

function isOptionalColumnError(error: unknown) {
  return ["subtasks", "status_changed_at", "action_type"].some((text) => errorMessageMentions(error, text));
}

function errorMessageMentions(error: unknown, text: string) {
  return error instanceof Error
    ? error.message.includes(text)
    : typeof error === "object" && error !== null && "message" in error && String(error.message).includes(text);
}
