import type { User } from "@supabase/supabase-js";
import { Task, TaskPrefix, TaskPriority, TaskStatus } from "@/lib/tasks";
import { supabase } from "@/lib/supabase";

type TaskRow = {
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
  created_at: string;
};

function dateOnly(value: string | null | undefined) {
  return value ? value.slice(0, 10) : undefined;
}

function toTimestamp(value: string | undefined) {
  if (!value) return null;
  return new Date(value.includes("T") ? value : `${value}T00:00:00`).toISOString();
}

function rowToTask(row: TaskRow): Task {
  return {
    id: `${row.prefix}${row.task_number}`,
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
    createdAt: dateOnly(row.created_at),
  };
}

function taskToUpsert(task: Task, user: User) {
  const now = new Date().toISOString();
  return {
    user_id: user.id,
    prefix: task.prefix,
    task_number: task.number,
    title: task.title,
    category: task.category,
    action_type: task.actionType ?? null,
    priority: task.priority,
    status: task.status,
    notes: task.notes ?? null,
    due_at: toTimestamp(task.dueDate),
    completed_at: toTimestamp(task.completedAt),
    status_changed_at: toTimestamp(task.statusChangedAt),
    created_at: toTimestamp(task.createdAt) ?? now,
    updated_at: now,
  };
}

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

export async function fetchCloudTasks() {
  const client = requireSupabase();
  const query = client
    .from("tasks")
    .select("prefix, task_number, title, category, action_type, priority, status, notes, due_at, completed_at, status_changed_at, created_at")
    .order("prefix", { ascending: true })
    .order("task_number", { ascending: true });
  const { data, error } = await query;

  if (error && errorMessageMentions(error, "status_changed_at")) {
    const fallback = await client
      .from("tasks")
      .select("prefix, task_number, title, category, action_type, priority, status, notes, due_at, completed_at, created_at")
      .order("prefix", { ascending: true })
      .order("task_number", { ascending: true });
    if (fallback.error && errorMessageMentions(fallback.error, "action_type")) {
      const legacyFallback = await fetchCloudTasksWithoutOptionalColumns(client);
      return legacyFallback;
    }
    if (fallback.error) throw fallback.error;
    return (fallback.data ?? []).map((row) => rowToTask(row as TaskRow));
  }

  if (error && errorMessageMentions(error, "action_type")) {
    return fetchCloudTasksWithoutOptionalColumns(client);
  }

  if (error) throw error;
  return (data ?? []).map((row) => rowToTask(row as TaskRow));
}

async function fetchCloudTasksWithoutOptionalColumns(client: ReturnType<typeof requireSupabase>) {
    const fallback = await client
      .from("tasks")
      .select("prefix, task_number, title, category, priority, status, notes, due_at, completed_at, created_at")
      .order("prefix", { ascending: true })
      .order("task_number", { ascending: true });
    if (fallback.error) throw fallback.error;
    return (fallback.data ?? []).map((row) => rowToTask(row as TaskRow));
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
  if (tasks.length === 0) return;
  const client = requireSupabase();
  const { error } = await client
    .from("tasks")
    .upsert(tasks.map((task) => taskToUpsert(task, user)), {
      onConflict: "user_id,prefix,task_number",
    });

  if (error && errorMessageMentions(error, "status_changed_at")) {
    const { error: fallbackError } = await client
      .from("tasks")
      .upsert(tasks.map((task) => ({
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
        created_at: toTimestamp(task.createdAt) ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        action_type: task.actionType ?? null,
      })), {
        onConflict: "user_id,prefix,task_number",
      });

    if (fallbackError && errorMessageMentions(fallbackError, "action_type")) {
      await saveCloudTasksWithoutOptionalColumns(tasks, user);
      return;
    }
    if (fallbackError) throw fallbackError;
    return;
  }

  if (error && errorMessageMentions(error, "action_type")) {
    await saveCloudTasksWithoutOptionalColumns(tasks, user);
    return;
  }

  if (error) throw error;
}

async function saveCloudTasksWithoutOptionalColumns(tasks: Task[], user: User) {
  const client = requireSupabase();
  const { error } = await client
    .from("tasks")
    .upsert(tasks.map((task) => ({
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
      created_at: toTimestamp(task.createdAt) ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })), {
      onConflict: "user_id,prefix,task_number",
    });

  if (error) throw error;
}

function errorMessageMentions(error: unknown, text: string) {
  return error instanceof Error
    ? error.message.includes(text)
    : typeof error === "object" && error !== null && "message" in error && String(error.message).includes(text);
}
