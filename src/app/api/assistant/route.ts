import { createClient } from "@supabase/supabase-js";
import type { AssistantResponse } from "@/lib/assistant";
import type { Task } from "@/lib/tasks";

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

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function visibleEnvironmentKeys() {
  return Object.keys(process.env)
    .filter((key) => key.includes("AI") || key.includes("GATEWAY") || key.includes("ASSISTANT"))
    .sort();
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

function extractJson(text: string): AssistantResponse {
  try {
    return JSON.parse(text) as AssistantResponse;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { reply: text.trim() || "לא הצלחתי לנסח תשובה כרגע." };
    try {
      return JSON.parse(match[0]) as AssistantResponse;
    } catch {
      return { reply: text.trim() || "לא הצלחתי לנסח תשובה כרגע." };
    }
  }
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

export async function POST(request: Request) {
  try {
    await verifyUser(request);

    const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_AI_GATEWAY_API_KEY;
    const model = process.env.ASSISTANT_MODEL;

    if (!apiKey) {
      return jsonResponse({
        error: `AI_GATEWAY_API_KEY חסר בשרת. משתנים גלויים: ${visibleEnvironmentKeys().join(", ") || "אין"}`,
        visibleEnvironmentKeys: visibleEnvironmentKeys(),
      }, 500);
    }
    if (!model) {
      return jsonResponse({
        error: `ASSISTANT_MODEL חסר בשרת. משתנים גלויים: ${visibleEnvironmentKeys().join(", ") || "אין"}`,
        visibleEnvironmentKeys: visibleEnvironmentKeys(),
      }, 500);
    }

    if (!apiKey) return jsonResponse({ error: "AI_GATEWAY_API_KEY חסר בשרת." }, 500);
    if (!model) return jsonResponse({ error: "ASSISTANT_MODEL חסר בשרת." }, 500);

    const body = await request.json() as AssistantRequestBody;
    const userMessage = body.message?.trim();
    if (!userMessage) return jsonResponse({ error: "חסרה הודעת משתמש." }, 400);

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
          {
            role: "system",
            content: [
              "אתה עוזר משימות אישי בתוך אפליקציה בעברית ו-RTL.",
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
              "אם המשתמש מבקש ניתוח או שאלה בלבד, אל תחזיר proposedAction.",
            ].join("\n"),
          },
          ...(body.recentMessages ?? []).slice(-8).map((message) => ({
            role: message.role,
            content: message.content,
          })),
          {
            role: "user",
            content: JSON.stringify({
              userMessage,
              taskSnapshot: buildTaskSnapshot(body.tasks ?? []),
              taxonomy: body.taxonomy ?? {},
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse({ error: `AI Gateway החזיר שגיאה: ${errorText}` }, 502);
    }

    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return jsonResponse({ error: "לא התקבלה תשובה מהמודל." }, 502);

    return jsonResponse(extractJson(content));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "שגיאה לא ידועה בצ׳ט." }, 500);
  }
}
