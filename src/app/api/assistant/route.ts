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

function visibleEnvironmentKeys() {
  return Object.keys(process.env)
    .filter((key) => key.includes("AI") || key.includes("GATEWAY") || key.includes("ASSISTANT") || key.includes("GEMINI"))
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

function buildSystemPrompt() {
  return [
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
    "אם המשתמש מבקש ניתוח או שאלה בלבד, אל תחזיר proposedAction.",
  ].join("\n");
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

async function callGemini(prompt: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

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
        temperature: 0.2,
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
        error: `לא הוגדר מנוע AI פעיל. נדרשים GEMINI_API_KEY או AI_GATEWAY_API_KEY. משתנים גלויים: ${visibleEnvironmentKeys().join(", ") || "אין"}`,
        visibleEnvironmentKeys: visibleEnvironmentKeys(),
      }, 500);
    }

    return jsonResponse(extractJson(content));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "שגיאה לא ידועה בצ׳ט." }, 500);
  }
}
