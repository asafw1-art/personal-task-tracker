import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { TaskSubtaskStatus } from "@/lib/tasks";

export type TaskShare = {
  id: string;
  taskId: string;
  ownerUserId: string;
  sharedWithUserId?: string;
  sharedWithEmail: string;
  role: "viewer" | "contributor";
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: string;
  acceptedAt?: string;
  updatedAt: string;
};

type TaskShareRow = {
  id: string;
  task_id: string;
  owner_user_id: string;
  shared_with_user_id: string | null;
  shared_with_email: string;
  role: "viewer" | "contributor";
  status: "pending" | "accepted" | "declined" | "revoked";
  created_at: string;
  accepted_at: string | null;
  updated_at: string;
};

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured");
  return supabase;
}

function rowToTaskShare(row: TaskShareRow): TaskShare {
  return {
    id: row.id,
    taskId: row.task_id,
    ownerUserId: row.owner_user_id,
    sharedWithUserId: row.shared_with_user_id ?? undefined,
    sharedWithEmail: row.shared_with_email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export async function fetchTaskShares() {
  const client = requireSupabase();
  const { data, error } = await client
    .from("task_shares")
    .select("id, task_id, owner_user_id, shared_with_user_id, shared_with_email, role, status, created_at, accepted_at, updated_at")
    .in("status", ["pending", "accepted"])
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => rowToTaskShare(row as TaskShareRow));
}

export async function createTaskShare(user: User, taskId: string, email: string) {
  const client = requireSupabase();
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("כתובת המייל אינה תקינה.");

  const { error } = await client
    .from("task_shares")
    .insert({
      task_id: taskId,
      owner_user_id: user.id,
      shared_with_email: cleanEmail,
      role: "contributor",
      status: "pending",
    });

  if (error) throw error;
}

export async function revokeTaskShare(shareId: string) {
  const client = requireSupabase();
  const { error } = await client
    .from("task_shares")
    .update({ status: "revoked", updated_at: new Date().toISOString() })
    .eq("id", shareId);

  if (error) throw error;
}

export async function acceptTaskShare(shareId: string) {
  const client = requireSupabase();
  const { error } = await client.rpc("accept_task_share", { p_share_id: shareId });
  if (error) throw error;
}

export async function declineTaskShare(shareId: string) {
  const client = requireSupabase();
  const { error } = await client.rpc("decline_task_share", { p_share_id: shareId });
  if (error) throw error;
}

export async function updateSharedTaskSubtaskStatus(taskCloudId: string, subtaskNumber: number, status: TaskSubtaskStatus) {
  const client = requireSupabase();
  const { error } = await client.rpc("update_shared_task_subtask_status", {
    p_task_id: taskCloudId,
    p_subtask_number: subtaskNumber,
    p_status: status,
  });
  if (error) throw error;
}
