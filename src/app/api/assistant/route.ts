import { createClient } from "@supabase/supabase-js";
import type { AssistantProposedAction, AssistantResponse } from "@/lib/assistant";
import { canonicalTaskId, type Task, type TaskPrefix, type TaskPriority, type TaskStatus, type TaskSubtaskStatus } from "@/lib/tasks";

export const runtime = "nodejs";

type AssistantRequestBody = {
  message?: string;
  tasks?: Task[];
  taxonomy?: {
    topics?: Record<string, string[]>;
    actions?: string[];
  };
  recentMessages?: { role: "user" | "assistant"; content: string }[];
};

type GeminiResponse = {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
  error?: {
    message?: string;
  };
};

type GatewayResponse = {
  choices?: {
    message?: {
      content?: string;
    };
  }[];
};

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function normalizeGeminiModel(model: string | undefined) {
  if (!model || model === "gemini-2.5-flash" || model === "gemini-3.5-flash") return "gemini-3.6-flash";
  return model;
}

function compactTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    prefix: task.prefix,
    category: task.category,
    actionType: task.actionType,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate,
    notes: task.notes,
    subtasks: (task.subtasks ?? []).map((subtask) => ({
      number: subtask.number,
      title: subtask.title,
      status: subtask.status,
      actionType: subtask.actionType,
    })),
  };
}

function buildTaskSnapshot(tasks: Task[]) {
  const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
  const completed = tasks.filter((task) => task.status === "done").slice(-12);
  return {
    total: tasks.length,
    activeCount: active.length,
    doneCount: tasks.filter((task) => task.status === "done").length,
    cancelledCount: tasks.filter((task) => task.status === "cancelled").length,
    active: active.slice(0, 80).map(compactTask),
    recentCompleted: completed.map(compactTask),
  };
}

function buildSystemPrompt() {
  return [
    "Safety policy: never propose deleting, cancelling, completing, or resetting all tasks or multiple tasks at once.",
    "Bulk task deletion, bulk cancellation, and full task reset are allowed only through the app settings, not through the AI chat.",
    "You may propose a destructive task action only for one explicitly identified existing task at a time, and it still requires user approval.",
    "There is no delete_task action. Do not invent one.",
    "Decision policy: do not propose marking a task as done only because it is old, overdue, or has the earliest due date.",
    "Only propose status=done when the user explicitly says the work was completed, finished, closed, handled, or asks to close/complete it.",
    "For old or overdue open tasks, prefer suggesting a review, moving the task to in_progress, adding a follow-up subtask, or filtering/showing the relevant tasks.",
    "If the user asks which task has been open the longest, answer with the task and explain why; do not propose completing it.",
    "אתה עוזר משימות אישי בתוך אפליקציה בעברית ובכיוון RTL.",
    "ענה בעברית קצרה, תכליתית ומעשית.",
    "מותר לך להציע פעולה אחת בלבד בכל תשובה, והאפליקציה תבצע אותה רק אחרי אישור המשתמש.",
    "אל תמציא מזהי משימות. אם הפעולה מתייחסת למשימה קיימת, השתמש רק במזהה שקיים בנתונים.",
    "החזר JSON בלבד במבנה: {\"reply\":\"...\",\"proposedAction\": optional}.",
    "proposedAction יכול להיות אחד מ:",
    "{\"type\":\"create_task\",\"label\":\"אישור וביצוע\",\"task\":{\"prefix\":\"P|W\",\"title\":\"...\",\"category\":\"...\",\"actionType\":\"...\",\"priority\":\"high|important|normal|low\",\"dueDate\":\"YYYY-MM-DD\",\"notes\":\"...\"}}",
    "{\"type\":\"update_task_status\",\"label\":\"אישור וביצוע\",\"taskId\":\"P20\",\"status\":\"open|in_progress|waiting|done|cancelled\"}",
    "{\"type\":\"add_subtask\",\"label\":\"אישור וביצוע\",\"taskId\":\"P20\",\"subtask\":{\"title\":\"...\",\"actionType\":\"...\"}}",
    "{\"type\":\"update_subtask_status\",\"label\":\"אישור וביצוע\",\"taskId\":\"P20\",\"subtaskNumber\":1,\"status\":\"open|done|cancelled\"}",
    "{\"type\":\"filter_tasks\",\"label\":\"הצג משימות\",\"filter\":{\"query\":\"...\",\"statusFilter\":\"active|overdue|subtasks_open|waiting|done|all\",\"prefixFilter\":\"P|W|all\",\"topicFilter\":\"...\",\"actionFilter\":\"...\"}}",
    "{\"type\":\"delete_assistant_history\",\"label\":\"אישור והעברה לשחזור\"}",
    "If the user asks to delete, clear, reset, erase, or remove the AI chat history, return proposedAction type delete_assistant_history. Explain that it will be hidden now and kept recoverable for 30 days.",
    "If the user asks to delete or clear all tasks, reply that this can only be done from settings and do not return proposedAction.",
    "אם המשתמש מבקש ניתוח או שאלה בלבד, אל תחזיר proposedAction.",
  ].join("\n");
}

function isAssistantResponse(value: unknown): value is AssistantResponse {
  return Boolean(value && typeof value === "object" && "reply" in value && typeof (value as { reply?: unknown }).reply === "string");
}

function parseAssistantResponse(text: string): AssistantResponse | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isAssistantResponse(parsed) ? parsed : null;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return isAssistantResponse(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function extractJson(text: string): AssistantResponse {
  const response = parseAssistantResponse(text);
  if (!response) return { reply: text.trim() || "לא הצלחתי לנסח תשובה כרגע." };

  const nested = parseAssistantResponse(response.reply.trim());
  if (nested) return nested;

  return response;
}

const taskStatuses = new Set<TaskStatus>(["open", "in_progress", "waiting", "done", "cancelled"]);
const subtaskStatuses = new Set<TaskSubtaskStatus>(["open", "done", "cancelled"]);
const taskPriorities = new Set<TaskPriority>(["high", "important", "normal", "low"]);
const taskPrefixes = new Set<TaskPrefix>(["P", "W"]);
const taskFilters = new Set(["active", "overdue", "subtasks_open", "waiting", "done", "all", "open", "in_progress", "cancelled", "focused", "today", "week", "no_due", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanOptionalText(value: unknown, maxLength: number) {
  const text = cleanText(value, maxLength);
  return text || undefined;
}

function cleanDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function findTask(tasks: Task[], taskId: unknown) {
  if (typeof taskId !== "string") return undefined;
  const id = canonicalTaskId(taskId);
  return id ? tasks.find((task) => task.id === id) : undefined;
}

function sanitizeAction(action: AssistantProposedAction | undefined, tasks: Task[], userMessage: string): AssistantProposedAction | undefined {
  if (!action) return undefined;
  if (!isRecord(action) || typeof action.type !== "string") return undefined;

  if (action.type === "delete_assistant_history") {
    return /צ[׳']?ט|שיח|שיחה|שיחות|chat|conversation|history|היסטור/i.test(userMessage)
      ? { type: "delete_assistant_history", label: "אישור והעברה לשחזור" }
      : undefined;
  }

  if (action.type === "create_task") {
    const task = isRecord(action.task) ? action.task : null;
    const title = cleanText(task?.title, 160);
    if (!title) return undefined;
    const prefix = taskPrefixes.has(task?.prefix as TaskPrefix) ? task?.prefix as TaskPrefix : "P";
    const priority = taskPriorities.has(task?.priority as TaskPriority) ? task?.priority as TaskPriority : "normal";

    return {
      type: "create_task",
      label: "אישור וביצוע",
      task: {
        prefix,
        title,
        category: cleanOptionalText(task?.category, 80),
        actionType: cleanOptionalText(task?.actionType, 80),
        priority,
        dueDate: cleanDate(task?.dueDate),
        notes: cleanOptionalText(task?.notes, 500),
      },
    };
  }

  if (action.type === "update_task_status") {
    const task = findTask(tasks, action.taskId);
    if (!task || !taskStatuses.has(action.status)) return undefined;
    return {
      type: "update_task_status",
      label: "אישור וביצוע",
      taskId: task.id,
      status: action.status,
    };
  }

  if (action.type === "add_subtask") {
    const task = findTask(tasks, action.taskId);
    const subtask = isRecord(action.subtask) ? action.subtask : null;
    const title = cleanText(subtask?.title, 160);
    if (!task || !title) return undefined;
    return {
      type: "add_subtask",
      label: "אישור וביצוע",
      taskId: task.id,
      subtask: {
        title,
        actionType: cleanOptionalText(subtask?.actionType, 80),
      },
    };
  }

  if (action.type === "update_subtask_status") {
    const task = findTask(tasks, action.taskId);
    const subtaskNumber = Number(action.subtaskNumber);
    const subtaskExists = task?.subtasks?.some((subtask) => subtask.number === subtaskNumber);
    if (!task || !Number.isInteger(subtaskNumber) || !subtaskExists || !subtaskStatuses.has(action.status)) return undefined;
    return {
      type: "update_subtask_status",
      label: "אישור וביצוע",
      taskId: task.id,
      subtaskNumber,
      status: action.status,
    };
  }

  if (action.type === "filter_tasks") {
    const filter = isRecord(action.filter) ? action.filter : {};
    const statusFilter = typeof filter.statusFilter === "string" && taskFilters.has(filter.statusFilter) ? filter.statusFilter : "active";
    const prefixFilter = filter.prefixFilter === "P" || filter.prefixFilter === "W" || filter.prefixFilter === "all" ? filter.prefixFilter : "all";
    return {
      type: "filter_tasks",
      label: "הצג משימות",
      filter: {
        query: cleanOptionalText(filter.query, 80),
        statusFilter,
        prefixFilter,
        topicFilter: cleanOptionalText(filter.topicFilter, 80),
        actionFilter: cleanOptionalText(filter.actionFilter, 80),
      },
    };
  }

  return undefined;
}

function sanitizeResponse(response: AssistantResponse, tasks: Task[], userMessage: string) {
  const proposedAction = sanitizeAction(response.proposedAction, tasks, userMessage);
  return proposedAction ? { ...response, proposedAction } : { reply: response.reply };
}

async function verifyUser(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!supabaseUrl || !supabaseKey) throw new Error("Supabase is not configured");
  if (!token) throw new Error("Missing session token");

  const client = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid session token");
  return data.user;
}

async function callGemini(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = normalizeGeminiModel(process.env.GEMINI_MODEL);

  if (!apiKey) return null;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await response.json() as GeminiResponse;
  if (!response.ok) throw new Error(`Gemini החזיר שגיאה: ${data.error?.message ?? JSON.stringify(data)}`);

  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!content) throw new Error("לא התקבלה תשובה מ-Gemini.");
  return content;
}

async function callVercelGateway(systemPrompt: string, userPayload: unknown, recentMessages: AssistantRequestBody["recentMessages"]) {
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_API_KEY;
  const model = process.env.ASSISTANT_MODEL;

  if (!apiKey || !model) return null;

  const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        ...(recentMessages ?? []).slice(-8).map((message) => ({
          role: message.role,
          content: message.content,
        })),
        {
          role: "user",
          content: JSON.stringify(userPayload),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Gateway החזיר שגיאה: ${errorText}`);
  }

  const data = await response.json() as GatewayResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("לא התקבלה תשובה מהמודל.");
  return content;
}

export async function POST(request: Request) {
  try {
    await verifyUser(request);

    const body = await request.json() as AssistantRequestBody;
    const userMessage = body.message?.trim();
    if (!userMessage) return jsonResponse({ error: "חסרה הודעת משתמש." }, 400);

    const systemPrompt = buildSystemPrompt();
    const userPayload = {
      userMessage,
      taskSnapshot: buildTaskSnapshot(body.tasks ?? []),
      taxonomy: body.taxonomy ?? {},
    };
    const geminiPrompt = [
      systemPrompt,
      "הודעות אחרונות:",
      JSON.stringify((body.recentMessages ?? []).slice(-8)),
      "נתוני הבקשה:",
      JSON.stringify(userPayload),
    ].join("\n\n");

    const content =
      await callGemini(geminiPrompt) ??
      await callVercelGateway(systemPrompt, userPayload, body.recentMessages);

    if (!content) {
      return jsonResponse({
        error: "לא הוגדר מנוע AI פעיל בשרת. בדוק שהוגדר מפתח Gemini או Vercel AI Gateway בסביבת Production ובצע Redeploy.",
      }, 500);
    }

    return jsonResponse(sanitizeResponse(extractJson(content), body.tasks ?? [], userMessage));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "שגיאה לא ידועה בצ׳ט." }, 500);
  }
}
