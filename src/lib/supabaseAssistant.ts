import type { User } from "@supabase/supabase-js";
import type { AssistantActionStatus, AssistantMessage, AssistantMessageRole, AssistantProposedAction, AssistantThread } from "@/lib/assistant";
import { supabase } from "@/lib/supabase";

type AssistantThreadRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
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
  const existing = await client
    .from("assistant_threads")
    .select("id, title, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

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
