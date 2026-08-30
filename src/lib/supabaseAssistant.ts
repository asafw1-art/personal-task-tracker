import type { User } from "@supabase/supabase-js";
import type { AssistantActionStatus, AssistantMessage, AssistantMessageRole, AssistantProposedAction, AssistantThread } from "@/lib/assistant";
import { supabase } from "@/lib/supabase";

type AssistantThreadRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  purge_after?: string | null;
};

type AssistantMessageRow = {
  id: string;
  thread_id: string;
  role: AssistantMessageRole;
  content: string;
  proposed_action: unknown;
  action_status: AssistantActionStatus | null;
  created_at: string;
};

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

function rowToThread(row: AssistantThreadRow): AssistantThread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    purgeAfter: row.purge_after ?? undefined,
  };
}

function rowToMessage(row: AssistantMessageRow): AssistantMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    proposedAction: parseProposedAction(row.proposed_action),
    actionStatus: row.action_status ?? undefined,
    createdAt: row.created_at,
  };
}

function parseProposedAction(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  return value as AssistantProposedAction;
}

export async function getOrCreateAssistantThread(user: User) {
  const client = requireSupabase();
  const activeQuery = client
    .from("assistant_threads")
    .select("id, title, created_at, updated_at, deleted_at, purge_after")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let existing = await activeQuery;

  if (existing.error && existing.error.message.includes("deleted_at")) {
    existing = await client
      .from("assistant_threads")
      .select("id, title, created_at, updated_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  }

  if (existing.error) throw existing.error;
  if (existing.data) return rowToThread(existing.data as AssistantThreadRow);

  const created = await client
    .from("assistant_threads")
    .insert({ user_id: user.id, title: "שיחה פעילה" })
    .select("id, title, created_at, updated_at")
    .single();

  if (created.error) throw created.error;
  return rowToThread(created.data as AssistantThreadRow);
}

export async function fetchAssistantMessages(threadId: string) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("assistant_messages")
    .select("id, thread_id, role, content, proposed_action, action_status, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => rowToMessage(row as AssistantMessageRow));
}

export async function addAssistantMessage(
  threadId: string,
  user: User,
  role: AssistantMessageRole,
  content: string,
  proposedAction?: AssistantProposedAction,
  actionStatus?: AssistantActionStatus,
) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("assistant_messages")
    .insert({
      thread_id: threadId,
      user_id: user.id,
      role,
      content,
      proposed_action: proposedAction ?? null,
      action_status: actionStatus ?? null,
    })
    .select("id, thread_id, role, content, proposed_action, action_status, created_at")
    .single();

  if (error) throw error;

  await client
    .from("assistant_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);

  return rowToMessage(data as AssistantMessageRow);
}

export async function updateAssistantMessageActionStatus(messageId: string, actionStatus: AssistantActionStatus) {
  const client = requireSupabase();
  const { error } = await client
    .from("assistant_messages")
    .update({ action_status: actionStatus })
    .eq("id", messageId);

  if (error) throw error;
}

export async function softDeleteAssistantHistory(user: User) {
  const client = requireSupabase();
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt);
  purgeAfter.setDate(purgeAfter.getDate() + 30);

  const { error } = await client
    .from("assistant_threads")
    .update({
      deleted_at: deletedAt.toISOString(),
      purge_after: purgeAfter.toISOString(),
      updated_at: deletedAt.toISOString(),
    })
    .eq("user_id", user.id)
    .is("deleted_at", null);

  if (error) throw error;
}

export async function fetchDeletedAssistantThreads(user: User) {
  const client = requireSupabase();
  await purgeExpiredAssistantThreads(user).catch(() => undefined);

  const { data, error } = await client
    .from("assistant_threads")
    .select("id, title, created_at, updated_at, deleted_at, purge_after")
    .eq("user_id", user.id)
    .not("deleted_at", "is", null)
    .gt("purge_after", new Date().toISOString())
    .order("deleted_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => rowToThread(row as AssistantThreadRow));
}

export async function restoreAssistantThread(threadId: string, user: User) {
  const client = requireSupabase();
  const restoredAt = new Date().toISOString();
  const { data, error } = await client
    .from("assistant_threads")
    .update({
      deleted_at: null,
      purge_after: null,
      updated_at: restoredAt,
    })
    .eq("id", threadId)
    .eq("user_id", user.id)
    .not("deleted_at", "is", null)
    .gt("purge_after", restoredAt)
    .select("id, title, created_at, updated_at, deleted_at, purge_after")
    .single();

  if (error) throw error;
  return rowToThread(data as AssistantThreadRow);
}

async function purgeExpiredAssistantThreads(user: User) {
  const client = requireSupabase();
  const { error } = await client
    .from("assistant_threads")
    .delete()
    .eq("user_id", user.id)
    .not("deleted_at", "is", null)
    .lte("purge_after", new Date().toISOString());

  if (error) throw error;
}
