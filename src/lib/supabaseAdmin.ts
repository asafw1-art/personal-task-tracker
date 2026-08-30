import { supabase } from "@/lib/supabase";

export type AdminOverview = {
  totalUsers: number;
  activeUsers7d: number;
  activeUsers30d: number;
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  acceptedShares: number;
  pendingShares: number;
  generatedAt: string;
};

type AdminOverviewRow = {
  total_users: number | string;
  active_users_7d: number | string;
  active_users_30d: number | string;
  total_tasks: number | string;
  active_tasks: number | string;
  completed_tasks: number | string;
  accepted_shares: number | string;
  pending_shares: number | string;
  generated_at: string;
};

export async function fetchAdminOverview(): Promise<AdminOverview> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc("get_admin_overview");
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as AdminOverviewRow | null;
  if (!row) throw new Error("לא התקבלו נתוני ניהול.");

  return {
    totalUsers: Number(row.total_users),
    activeUsers7d: Number(row.active_users_7d),
    activeUsers30d: Number(row.active_users_30d),
    totalTasks: Number(row.total_tasks),
    activeTasks: Number(row.active_tasks),
    completedTasks: Number(row.completed_tasks),
    acceptedShares: Number(row.accepted_shares),
    pendingShares: Number(row.pending_shares),
    generatedAt: row.generated_at,
  };
}
