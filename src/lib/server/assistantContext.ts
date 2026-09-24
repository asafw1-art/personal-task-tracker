import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Task, TaskSubtask } from "@/lib/tasks";
import { selectAssistantContext } from "@/lib/assistantPrivacy";
import type { AssistantContextPreview } from "@/lib/assistantPrivacy";

export async function loadOwnedAssistantTasks(request: Request, userId: string, includeDetails: boolean): Promise<Task[]> {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: request.headers.get("authorization")! } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const columns = `prefix,task_number,title,category,priority,status,due_at,subtasks${includeDetails ? ",notes" : ""}`;
  const { data, error } = await client.from("tasks").select(columns).eq("user_id", userId)
    .order("prefix").order("task_number").limit(1001);
  if (error || !data || data.length > 1000) throw new Error("assistant_context_unavailable");
  return (data as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: `${row.prefix}${row.task_number}`, prefix: row.prefix as Task["prefix"], number: Number(row.task_number),
    title: String(row.title), category: String(row.category), priority: row.priority as Task["priority"],
    status: row.status as Task["status"], dueDate: typeof row.due_at === "string" ? row.due_at.slice(0, 10) : undefined,
    notes: includeDetails && typeof row.notes === "string" ? row.notes : undefined,
    subtasks: Array.isArray(row.subtasks) ? row.subtasks.filter((step): step is TaskSubtask =>
      Boolean(step && typeof step === "object" && typeof step.title === "string" && Number.isInteger(step.number) && ["open", "done", "cancelled"].includes(step.status))) : [],
  }));
}

export function makeContextPreview(userId: string, message: string, tasks: Task[], includeDetails: boolean, providers: AssistantContextPreview["providers"]): AssistantContextPreview {
  const payload = { message, includeDetails, tasks: selectAssistantContext(message, tasks, includeDetails), providers };
  // Bind approval to the authenticated owner and exact payload, including recipients.
  const digest = createHash("sha256").update(JSON.stringify({ userId, ...payload })).digest("hex");
  return { digest, ...payload };
}
