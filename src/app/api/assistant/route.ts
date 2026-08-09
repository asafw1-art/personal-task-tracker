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

type AssistantProviderResult = {
  content?: string;
  provider?: string;
  error?: string;
};

const MAX_ASSISTANT_MESSAGE_LENGTH = 1_500;
const MAX_ASSISTANT_TASKS = 160;
const MAX_ASSISTANT_RECENT_MESSAGES = 8;
const MAX_ASSISTANT_PAYLOAD_BYTES = 120_000;
const ASSISTANT_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const ASSISTANT_RATE_LIMIT_MAX_REQUESTS = 25;

const assistantRateLimits = new Map<string, { count: number; resetAt: number }>();

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class AiProviderError extends Error {
  constructor(message: string, readonly provider: string) {
    super(message);
  }
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function normalizeGeminiModel(model: string | undefined) {
  const normalized = model?.trim().replace(/^models\//, "");
  if (!normalized || normalized === "3.6") return "gemini-3.6-flash";
  if (normalized === "3.5") return "gemini-3.5-flash";
  if (
    normalized === "gemini-2.0-flash" ||
    normalized === "gemini-2.5-flash" ||
    normalized === "gemini-3-flash-preview"
  ) {
    return "gemini-3.6-flash";
  }
  return normalized;
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

function taskDisplay(task: Task) {
  return `${task.id} - ${task.title}`;
}

function isTaskActive(task: Task) {
  return !["done", "cancelled"].includes(task.status);
}

function isTaskOverdue(task: Task, today: string) {
  const dueDate = task.dueDate;
  if (!dueDate) return false;
  return isTaskActive(task) && dueDate < today;
}

function countOpenSubtasks(task: Task) {
  return (task.subtasks ?? []).filter((subtask) => subtask.status === "open").length;
}

function listPreview(tasks: Task[]) {
  if (tasks.length === 0) return "";
  return tasks.slice(0, 5).map(taskDisplay).join("\n");
}

function localAssistantResponse(message: string, tasks: Task[]): AssistantResponse | null {
  const normalized = message.toLowerCase();
  const today = new Date().toISOString().slice(0, 10);

  if (/צ[׳']?ט|שיח|שיחה|שיחות|chat|conversation|history|היסטור/i.test(message) && /מחק|מחיקה|נקה|אפס|delete|clear|reset/i.test(message)) {
    return {
      reply: "אפשר למחוק את שיחת ה-AI הפעילה. היא תוסתר עכשיו ותישמר לשחזור אישי למשך 30 יום.",
      proposedAction: { type: "delete_assistant_history", label: "אישור והעברה לשחזור" },
    };
  }

  if (/כל המשימות|איפוס|reset all|delete all|מחק הכל|לבטל הכל/i.test(message)) {
    return {
      reply: "מחיקה, ביטול או איפוס של כל המשימות אפשריים רק דרך ההגדרות, ולא דרך צ׳ט ה-AI.",
    };
  }

  if (/באיחור|איחור|overdue/i.test(normalized)) {
    const overdue = tasks.filter((task) => isTaskOverdue(task, today));
    return {
      reply: overdue.length
        ? `יש ${overdue.length} משימות באיחור:\n${listPreview(overdue)}`
        : "אין כרגע משימות באיחור.",
      proposedAction: { type: "filter_tasks", label: "הצג באיחור", filter: { statusFilter: "overdue", prefixFilter: "all" } },
    };
  }

  if (/צעדי טיפול|צעדים|תתי|subtasks/i.test(normalized) && /פתוח|פתוחים|open/i.test(normalized)) {
    const withOpenSubtasks = tasks.filter((task) => isTaskActive(task) && countOpenSubtasks(task) > 0);
    const openSubtasks = withOpenSubtasks.reduce((sum, task) => sum + countOpenSubtasks(task), 0);
    return {
      reply: openSubtasks
        ? `יש ${openSubtasks} צעדי טיפול פתוחים בתוך ${withOpenSubtasks.length} משימות:\n${listPreview(withOpenSubtasks)}`
        : "אין כרגע צעדי טיפול פתוחים.",
      proposedAction: { type: "filter_tasks", label: "הצג צעדים פתוחים", filter: { statusFilter: "subtasks_open", prefixFilter: "all" } },
    };
  }

  if (/ממתינ|waiting/i.test(normalized)) {
    const waiting = tasks.filter((task) => task.status === "waiting");
    return {
      reply: waiting.length ? `יש ${waiting.length} משימות ממתינות:\n${listPreview(waiting)}` : "אין כרגע משימות ממתינות.",
      proposedAction: { type: "filter_tasks", label: "הצג ממתינות", filter: { statusFilter: "waiting", prefixFilter: "all" } },
    };
  }

  if (/פתוח|פתוחות|פעילות|active|open/i.test(normalized)) {
    const active = tasks.filter(isTaskActive);
    return {
      reply: active.length ? `יש ${active.length} משימות פעילות:\n${listPreview(active)}` : "אין כרגע משימות פעילות.",
      proposedAction: { type: "filter_tasks", label: "הצג פעילות", filter: { statusFilter: "active", prefixFilter: "all" } },
    };
  }

  if (/כמה|סיכום|מצב|תמונה|status|summary/i.test(normalized)) {
    const active = tasks.filter(isTaskActive).length;
    const overdue = tasks.filter((task) => isTaskOverdue(task, today)).length;
    const waiting = tasks.filter((task) => task.status === "waiting").length;
    const done = tasks.filter((task) => task.status === "done").length;
    const openSubtasks = tasks.reduce((sum, task) => sum + countOpenSubtasks(task), 0);
    return {
      reply: `תמונת מצב קצרה:\n${active} משימות פעילות\n${overdue} משימות באיחור\n${waiting} משימות ממתינות\n${openSubtasks} צעדי טיפול פתוחים\n${done} משימות הושלמו`,
    };
  }

  return null;
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

  if (!supabaseUrl || !supabaseKey) throw new HttpError("Supabase is not configured", 500);
  if (!token) throw new HttpError("Missing session token", 401);

  const client = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError("Invalid session token", 401);
  return data.user;
}

function checkRequestSize(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ASSISTANT_PAYLOAD_BYTES) {
    throw new HttpError("הבקשה גדולה מדי. נסה לשלוח הודעה קצרה יותר.", 413);
  }
}

function checkRateLimit(userId: string) {
  const now = Date.now();
  const current = assistantRateLimits.get(userId);

  if (!current || current.resetAt <= now) {
    assistantRateLimits.set(userId, { count: 1, resetAt: now + ASSISTANT_RATE_LIMIT_WINDOW_MS });
    return;
  }

  if (current.count >= ASSISTANT_RATE_LIMIT_MAX_REQUESTS) {
    const seconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    throw new HttpError(`יותר מדי בקשות לצ׳ט. נסה שוב בעוד ${seconds} שניות.`, 429);
  }

  current.count += 1;
}

function normalizeAssistantRequestBody(body: AssistantRequestBody): Required<AssistantRequestBody> {
  const message = body.message?.trim() ?? "";
  if (!message) throw new HttpError("חסרה הודעת משתמש.", 400);
  if (message.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    throw new HttpError("ההודעה ארוכה מדי. נסה לקצר אותה.", 400);
  }

  return {
    message,
    tasks: Array.isArray(body.tasks) ? body.tasks.slice(0, MAX_ASSISTANT_TASKS) : [],
    taxonomy: body.taxonomy ?? {},
    recentMessages: Array.isArray(body.recentMessages)
      ? body.recentMessages.slice(-MAX_ASSISTANT_RECENT_MESSAGES)
      : [],
  };
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
  if (!response.ok) throw new AiProviderError(data.error?.message ?? "Gemini request failed", "Gemini");

  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!content) throw new AiProviderError("No Gemini response content", "Gemini");
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
    throw new AiProviderError(errorText, "AI Gateway");
  }

  const data = await response.json() as GatewayResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new AiProviderError("No gateway response content", "AI Gateway");
  return content;
}

function errorMessageForLog(error: unknown) {
  return error instanceof Error ? error.message : "Unknown provider error";
}

async function callAssistantProvider(systemPrompt: string, geminiPrompt: string, userPayload: unknown, recentMessages: AssistantRequestBody["recentMessages"]): Promise<AssistantProviderResult> {
  const errors: string[] = [];

  try {
    const content = await callGemini(geminiPrompt);
    if (content) return { content, provider: "Gemini" };
  } catch (error) {
    errors.push(error instanceof AiProviderError ? `${error.provider}: ${error.message}` : errorMessageForLog(error));
  }

  try {
    const content = await callVercelGateway(systemPrompt, userPayload, recentMessages);
    if (content) return { content, provider: "AI Gateway" };
  } catch (error) {
    errors.push(error instanceof AiProviderError ? `${error.provider}: ${error.message}` : errorMessageForLog(error));
  }

  const error = errors.join(" | ") || "No AI provider configured";
  console.error("Assistant provider unavailable", error);
  return {
    content: JSON.stringify({
      reply: "העוזר החכם לא זמין כרגע. אפשר עדיין לשאול שאלות פשוטות כמו: מה המשימות הפתוחות שלי, מה באיחור, או כמה צעדי טיפול פתוחים יש.",
      fallback: true,
    }),
    error,
  };
}

export async function POST(request: Request) {
  try {
    checkRequestSize(request);
    const user = await verifyUser(request);
    checkRateLimit(user.id);

    const body = normalizeAssistantRequestBody(await request.json() as AssistantRequestBody);
    const userMessage = body.message;

    const systemPrompt = buildSystemPrompt();
    const userPayload = {
      userMessage,
      taskSnapshot: buildTaskSnapshot(body.tasks),
      taxonomy: body.taxonomy,
    };

    const localResponse = localAssistantResponse(userMessage, body.tasks);
    if (localResponse) return jsonResponse(sanitizeResponse(localResponse, body.tasks, userMessage));

    const geminiPrompt = [
      systemPrompt,
      "הודעות אחרונות:",
      JSON.stringify(body.recentMessages),
      "נתוני הבקשה:",
      JSON.stringify(userPayload),
    ].join("\n\n");

    const providerResult = await callAssistantProvider(systemPrompt, geminiPrompt, userPayload, body.recentMessages);
    const content = providerResult.content;

    if (!content) {
      return jsonResponse({
        error: "לא הוגדר מנוע AI פעיל בשרת. בדוק שהוגדר מפתח Gemini או Vercel AI Gateway בסביבת Production ובצע Redeploy.",
      }, 500);
    }

    return jsonResponse(sanitizeResponse(extractJson(content), body.tasks, userMessage));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return jsonResponse({ error: error instanceof Error ? error.message : "שגיאה לא ידועה בצ׳ט." }, status);
  }
}
