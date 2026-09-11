import type { User } from "@supabase/supabase-js";
import type { AssistantActionStatus, AssistantArchiveSearchResult, AssistantMessage, AssistantMessageRole, AssistantProposedAction, AssistantThread } from "@/lib/assistant";
import { supabase } from "@/lib/supabase";

type AssistantThreadRow = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  continued_from_thread_id?: string | null;
  archived_at?: string | null;
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

type AssistantArchiveSearchMessageRow = Pick<AssistantMessageRow, "id" | "thread_id" | "content" | "created_at">;

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
    continuedFromThreadId: row.continued_from_thread_id ?? undefined,
    archivedAt: row.archived_at ?? undefined,
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
    .select("id, title, created_at, updated_at, continued_from_thread_id, archived_at, deleted_at, purge_after")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let existing = await activeQuery;

  if (existing.error?.message.includes("continued_from_thread_id")) {
    existing = await client
      .from("assistant_threads")
      .select("id, title, created_at, updated_at, archived_at, deleted_at, purge_after")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  } else if (existing.error && (existing.error.message.includes("deleted_at") || existing.error.message.includes("archived_at"))) {
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
    .select("id, title, created_at, updated_at, continued_from_thread_id")
    .single();

  if (created.error) throw created.error;
  return rowToThread(created.data as AssistantThreadRow);
}

async function assertArchivedAssistantThread(threadId: string, user: User) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("assistant_threads")
    .select("id")
    .eq("id", threadId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .not("archived_at", "is", null)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("שיחת המקור אינה זמינה בארכיון האישי שלך.");
}

export async function assertAssistantContinuationReady(activeThreadId: string, user: User) {
  const client = requireSupabase();
  const { error } = await client
    .from("assistant_threads")
    .select("continued_from_thread_id")
    .eq("id", activeThreadId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
}

export async function continueAssistantThreadFromArchive(
  activeThreadId: string,
  sourceThreadId: string,
  user: User,
  reuseEmptyActiveThread: boolean,
) {
  const client = requireSupabase();
  await assertArchivedAssistantThread(sourceThreadId, user);
  await assertAssistantContinuationReady(activeThreadId, user);
  const updatedAt = new Date().toISOString();

  if (reuseEmptyActiveThread) {
    const { data, error } = await client
      .from("assistant_threads")
      .update({
        title: "המשך שיחה",
        continued_from_thread_id: sourceThreadId,
        updated_at: updatedAt,
      })
      .eq("id", activeThreadId)
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .is("archived_at", null)
      .select("id, title, created_at, updated_at, continued_from_thread_id, archived_at, deleted_at, purge_after")
      .single();

    if (error) throw error;
    return rowToThread(data as AssistantThreadRow);
  }

  const { data, error } = await client
    .from("assistant_threads")
    .insert({
      user_id: user.id,
      title: "המשך שיחה",
      continued_from_thread_id: sourceThreadId,
    })
    .select("id, title, created_at, updated_at, continued_from_thread_id, archived_at, deleted_at, purge_after")
    .single();

  if (error) throw error;
  return rowToThread(data as AssistantThreadRow);
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

  let result = await client
    .from("assistant_threads")
    .update({
      deleted_at: deletedAt.toISOString(),
      purge_after: purgeAfter.toISOString(),
      updated_at: deletedAt.toISOString(),
    })
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .is("archived_at", null);

  // Keep existing installations usable until the archive migration is applied.
  if (result.error?.message.includes("archived_at")) {
    result = await client
      .from("assistant_threads")
      .update({
        deleted_at: deletedAt.toISOString(),
        purge_after: purgeAfter.toISOString(),
        updated_at: deletedAt.toISOString(),
      })
      .eq("user_id", user.id)
      .is("deleted_at", null);
  }

  if (result.error) throw result.error;
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

export async function fetchArchivedAssistantThreads(user: User) {
  const client = requireSupabase();
  const { data, error } = await client
    .from("assistant_threads")
    .select("id, title, created_at, updated_at, archived_at, deleted_at, purge_after")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => rowToThread(row as AssistantThreadRow));
}

function searchExcerpt(content: string, query: string) {
  const normalizedContent = content.toLocaleLowerCase();
  const term = query.toLocaleLowerCase().split(/\s+/).find(Boolean) ?? query.toLocaleLowerCase();
  const matchIndex = normalizedContent.indexOf(term);
  if (matchIndex < 0) return content.slice(0, 180).trim();

  const start = Math.max(0, matchIndex - 64);
  const end = Math.min(content.length, matchIndex + term.length + 116);
  return `${start > 0 ? "..." : ""}${content.slice(start, end).trim()}${end < content.length ? "..." : ""}`;
}

export async function searchArchivedAssistantMessages(user: User, rawQuery: string) {
  const query = rawQuery.trim().replace(/[\\%_]/g, " ").replace(/\s+/g, " ").slice(0, 80);
  if (query.length < 2) return [] as AssistantArchiveSearchResult[];

  const threads = await fetchArchivedAssistantThreads(user);
  if (!threads.length) return [] as AssistantArchiveSearchResult[];

  const client = requireSupabase();
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const { data, error } = await client
    .from("assistant_messages")
    .select("id, thread_id, content, created_at")
    .eq("user_id", user.id)
    .in("thread_id", threads.map((thread) => thread.id))
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(32);

  if (error) throw error;

  const seenThreadIds = new Set<string>();
  return (data ?? []).reduce<AssistantArchiveSearchResult[]>((results, row) => {
    const message = row as AssistantArchiveSearchMessageRow;
    const thread = threadById.get(message.thread_id);
    if (!thread || seenThreadIds.has(thread.id)) return results;
    seenThreadIds.add(thread.id);
    results.push({
      thread,
      messageId: message.id,
      excerpt: searchExcerpt(message.content, query),
      matchedAt: message.created_at,
    });
    return results;
  }, []).slice(0, 8);
}

export async function archiveAssistantThread(threadId: string, user: User) {
  const client = requireSupabase();
  const archivedAt = new Date().toISOString();
  const { data, error } = await client
    .from("assistant_threads")
    .update({ archived_at: archivedAt, updated_at: archivedAt })
    .eq("id", threadId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .is("archived_at", null)
    .select("id, title, created_at, updated_at, archived_at, deleted_at, purge_after")
    .single();

  if (error) throw error;
  return rowToThread(data as AssistantThreadRow);
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
