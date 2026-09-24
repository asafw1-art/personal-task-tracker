import { canonicalTaskId, type Task } from "@/lib/tasks";

export type AssistantContextTask = {
  id: string;
  status: Task["status"];
  priority: Task["priority"];
  dueDate?: string;
  title?: string;
  notes?: string;
  subtasks?: { number: number; title: string; status: string }[];
};

export type AssistantContextPreview = {
  digest: string;
  message: string;
  includeDetails: boolean;
  tasks: AssistantContextTask[];
  providers: { id: string; label: string; model: string; privacyVerified: boolean }[];
};

// No historical messages or client-supplied task text enter this selection.
export function selectAssistantContext(message: string, ownedTasks: Task[], includeDetails: boolean) {
  const ids = new Set((message.match(/\b[PW][- ]?0*\d+\b/gi) ?? []).map(canonicalTaskId));
  const candidates = ownedTasks.filter((task) => !task.sharedWithMe && !task.historicalShared);
  const isPrioritization = /תעד[וו]ף|לתעדף|לקדם|להתחיל|דחופ|דחיף|חשוב|prioriti[sz]|recommend/i.test(message);
  const weights = { high: 0, important: 1, normal: 2, low: 3 };
  const selected = ids.size
    ? candidates.filter((task) => ids.has(task.id))
    : isPrioritization
      ? candidates.filter((task) => !["done", "cancelled"].includes(task.status)).sort((a, b) =>
        (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || weights[a.priority] - weights[b.priority] || a.id.localeCompare(b.id))
      : [];
  return selected.slice(0, 8).map((task): AssistantContextTask => ({
    id: task.id, status: task.status, priority: task.priority,
    ...(task.dueDate ? { dueDate: task.dueDate } : {}),
    ...(ids.size || includeDetails ? { title: task.title.slice(0, 200) } : {}),
    ...(includeDetails ? {
      ...(task.notes ? { notes: task.notes.slice(0, 500) } : {}),
      subtasks: (task.subtasks ?? []).slice(0, 8).map((step) => ({ number: step.number, title: step.title.slice(0, 200), status: step.status })),
    } : {}),
  }));
}
