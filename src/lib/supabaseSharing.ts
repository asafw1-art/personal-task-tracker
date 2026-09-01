import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { Task, TaskPriority, TaskStatus, TaskSubtask, TaskSubtaskStatus } from "@/lib/tasks";

export type TaskShareSnapshot = {
  prefix?: "P" | "W";
  number?: number;
  title?: string;
  category?: string;
  actionType?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
  notes?: string | null;
  dueDate?: string | null;
  completedAt?: string | null;
  statusChangedAt?: string | null;
  subtasks?: TaskSubtask[];
  createdAt?: string | null;
};

export type TaskShare = {
  id: string;
  taskId: string;
  ownerUserId: string;
  sharedWithUserId?: string;
  sharedWithEmail: string;
  role: "viewer" | "contributor";
  status: "pending" | "accepted" | "declined" | "revoked" | "left";
  ownerDisplayName?: string;
  ownerEmail?: string;
  taskTitle?: string;
  taskPrefix?: "P" | "W";
  taskNumber?: number;
  recipientDisplayName?: string;
  focused: boolean;
  createdAt: string;
  acceptedAt?: string;
  endedAt?: string;
  endReason?: "owner_revoked" | "recipient_left";
  taskSnapshot?: TaskShareSnapshot;
  endSeenAt?: string;
  updatedAt: string;
};

export type TaskSubtaskAssignment = {
  id: string;
  taskId: string;
  subtaskId: string;
  subtaskNumber: number;
  shareId: string;
  ownerUserId: string;
  assigneeUserId?: string;
  assigneeEmail: string;
  assigneeDisplayName?: string;
  assignedAt: string;
  endedAt?: string;
  endReason?: "unassigned" | "reassigned" | "share_ended" | "subtask_removed";
  updatedAt: string;
};

type TaskShareRow = {
  id: string;
  task_id: string;
  owner_user_id: string;
  shared_with_user_id: string | null;
  shared_with_email: string;
  role: "viewer" | "contributor";
  status: "pending" | "accepted" | "declined" | "revoked" | "left";
  owner_display_name: string | null;
  owner_email: string | null;
  task_title: string | null;
  task_prefix: "P" | "W" | null;
  task_number: number | null;
  recipient_display_name: string | null;
  focused: boolean | null;
  created_at: string;
  accepted_at: string | null;
  ended_at: string | null;
  end_reason: "owner_revoked" | "recipient_left" | null;
  task_snapshot: TaskShareSnapshot | null;
  end_seen_at: string | null;
  updated_at: string;
};

type TaskSubtaskAssignmentRow = {
  id: string;
  task_id: string;
  subtask_id: string;
  subtask_number: number;
  share_id: string;
  owner_user_id: string;
  assignee_user_id: string | null;
  assignee_email: string;
  assignee_display_name: string | null;
  assigned_at: string;
  ended_at: string | null;
  end_reason: "unassigned" | "reassigned" | "share_ended" | "subtask_removed" | null;
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
    ownerDisplayName: row.owner_display_name?.trim() || undefined,
    ownerEmail: row.owner_email?.trim() || undefined,
    taskTitle: row.task_title?.trim() || undefined,
    taskPrefix: row.task_prefix ?? undefined,
    taskNumber: row.task_number ?? undefined,
    recipientDisplayName: row.recipient_display_name?.trim() || undefined,
    focused: row.focused === true,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    endReason: row.end_reason ?? undefined,
    taskSnapshot: row.task_snapshot ?? undefined,
    endSeenAt: row.end_seen_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToSubtaskAssignment(row: TaskSubtaskAssignmentRow): TaskSubtaskAssignment {
  return {
    id: row.id,
    taskId: row.task_id,
    subtaskId: row.subtask_id,
    subtaskNumber: row.subtask_number,
    shareId: row.share_id,
    ownerUserId: row.owner_user_id,
    assigneeUserId: row.assignee_user_id ?? undefined,
    assigneeEmail: row.assignee_email,
    assigneeDisplayName: row.assignee_display_name?.trim() || undefined,
    assignedAt: row.assigned_at,
    endedAt: row.ended_at ?? undefined,
    endReason: row.end_reason ?? undefined,
    updatedAt: row.updated_at,
  };
}

export async function fetchTaskShares() {
  const client = requireSupabase();
  const { data, error } = await client
    .from("task_shares")
    .select("id, task_id, owner_user_id, shared_with_user_id, shared_with_email, role, status, owner_display_name, owner_email, task_title, task_prefix, task_number, recipient_display_name, focused, created_at, accepted_at, ended_at, end_reason, task_snapshot, end_seen_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => rowToTaskShare(row as TaskShareRow));
}

export async function fetchTaskSubtaskAssignments() {
  const client = requireSupabase();
  const { data, error } = await client
    .from("task_subtask_assignments")
    .select("id, task_id, subtask_id, subtask_number, share_id, owner_user_id, assignee_user_id, assignee_email, assignee_display_name, assigned_at, ended_at, end_reason, updated_at")
    .order("assigned_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => rowToSubtaskAssignment(row as TaskSubtaskAssignmentRow));
}

export async function setTaskSubtaskAssignment(taskCloudId: string, subtaskNumber: number, shareId?: string) {
  const client = requireSupabase();
  const { error } = await client.rpc("set_task_subtask_assignment", {
    p_task_id: taskCloudId,
    p_subtask_number: subtaskNumber,
    p_share_id: shareId ?? null,
  });
  if (error) throw error;
}

export async function createTaskShare(user: User, task: Pick<Task, "cloudId" | "title" | "prefix" | "number">, email: string, ownerDisplayName?: string) {
  const client = requireSupabase();
  const cleanEmail = email.trim().toLowerCase();
  if (!task.cloudId) throw new Error("המשימה עדיין לא סונכרנה לענן.");
  if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("כתובת המייל אינה תקינה.");

  const { error } = await client
    .from("task_shares")
    .insert({
      task_id: task.cloudId,
      owner_user_id: user.id,
      owner_display_name: ownerDisplayName?.trim() || user.email?.split("@")[0] || null,
      owner_email: user.email?.trim().toLowerCase() || null,
      task_title: task.title,
      task_prefix: task.prefix,
      task_number: task.number,
      shared_with_email: cleanEmail,
      role: "contributor",
      status: "pending",
    });

  if (error) throw error;
}

export async function revokeTaskShare(shareId: string) {
  const client = requireSupabase();
  const { error } = await client.rpc("revoke_task_share", { p_share_id: shareId });

  if (error) throw error;
}

export async function leaveTaskShare(shareId: string) {
  const client = requireSupabase();
  const { error } = await client.rpc("leave_task_share", { p_share_id: shareId });
  if (error) throw error;
}

export async function setSharedTaskFocus(shareId: string, focused: boolean) {
  const client = requireSupabase();
  const { error } = await client.rpc("set_shared_task_focus", { p_share_id: shareId, p_focused: focused });
  if (error) throw error;
}

export async function acknowledgeTaskShareEnd(shareId: string) {
  const client = requireSupabase();
  const { error } = await client.rpc("acknowledge_task_share_end", { p_share_id: shareId });
  if (error) throw error;
}

export function historicalTaskFromShare(share: TaskShare): Task | null {
  const snapshot = share.taskSnapshot;
  if (!snapshot || (snapshot.prefix !== "P" && snapshot.prefix !== "W")) return null;
  if (!Number.isInteger(snapshot.number) || Number(snapshot.number) <= 0 || !snapshot.title || !snapshot.category) return null;
  if (!snapshot.priority || !snapshot.status) return null;

  return {
    id: `past-share:${share.id}`,
    ownerUserId: share.ownerUserId,
    sharedWithMe: true,
    shareId: share.id,
    sharedByName: share.ownerDisplayName,
    sharedByEmail: share.ownerEmail,
    historicalShared: true,
    shareEndedAt: share.endedAt,
    prefix: snapshot.prefix,
    number: Number(snapshot.number),
    title: snapshot.title,
    category: snapshot.category,
    actionType: snapshot.actionType ?? undefined,
    priority: snapshot.priority,
    status: snapshot.status,
    notes: snapshot.notes ?? undefined,
    dueDate: snapshot.dueDate ?? undefined,
    completedAt: snapshot.completedAt ?? undefined,
    statusChangedAt: snapshot.statusChangedAt ?? undefined,
    subtasks: Array.isArray(snapshot.subtasks) ? snapshot.subtasks : [],
    focused: share.focused,
    createdAt: snapshot.createdAt?.slice(0, 10) ?? undefined,
  };
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
