"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChangeEvent, Dispatch, FormEvent, SetStateAction } from "react";
import type { User } from "@supabase/supabase-js";
import { canonicalTaskId, initialTasks, Task, TaskPrefix, TaskPriority, TaskStatus } from "@/lib/tasks";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { fetchUserDevices, registerCurrentDevice, type UserDevice } from "@/lib/supabaseDevices";
import { countCloudTasks, fetchCloudTasks, saveCloudTasks } from "@/lib/supabaseTasks";
import { fetchCloudTaxonomy, replaceCloudTaxonomy } from "@/lib/supabaseTaxonomy";

const STORAGE_KEY = "asaf-task-tracker-v1";
const TAXONOMY_STORAGE_KEY = "asaf-task-tracker-taxonomy-v1";

const statusLabels: Record<TaskStatus, string> = {
  open: "פתוחה",
  in_progress: "בטיפול",
  waiting: "ממתינה",
  done: "בוצעה",
  cancelled: "בוטלה",
};

const priorityLabels: Record<TaskPriority, string> = {
  high: "גבוהה",
  important: "חשובה",
  normal: "רגילה",
  low: "נמוכה",
};

const defaultTaxonomy: TaskTaxonomy = {
  topics: {
    P: ["אישי", "פרישה", "בריאות", "בית", "כספים", "משפחה", "סידורים"],
    W: ["עבודה", "פרויקטים", "פגישות", "דיווחים", "מעקב", "Galaxy"],
  },
  actions: ["טלפון", "פגישה", "מסמך", "תשלום", "מעקב", "קנייה", "בדיקה", "אחר"],
};

const kanbanStatuses: TaskStatus[] = ["open", "in_progress", "waiting", "done", "cancelled"];
const activeKanbanStatuses: TaskStatus[] = ["open", "in_progress", "waiting"];

type StatRow = {
  label: string;
  value: number;
};

type AnalyticsInsight = {
  id: string;
  title: string;
  body: string;
  tone: "danger" | "warn" | "good" | "neutral";
  actionLabel?: string;
  action?: {
    statusFilter?: TaskFilter;
    topicFilter?: string;
    query?: string;
  };
};

type ImportSummary = {
  added: number;
  updated: number;
  skipped: number;
};

type TaskFilter = TaskStatus | "active" | "all" | "overdue" | "today" | "week" | "no_due" | "high";
type AnalyticsRange = "week" | "month" | "all";
type MainView = "tasks" | "stats" | "kanban";
type TaxonomyMode = "topics" | "actions";
type SettingsTab = "taxonomy" | "sync";

type TaskTaxonomy = {
  topics: Record<TaskPrefix, string[]>;
  actions: string[];
};

type TaskDraft = {
  prefix: TaskPrefix;
  title: string;
  category: string;
  actionType: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
  notes: string;
};

type TaskEditorState =
  | { mode: "create"; draft: TaskDraft }
  | { mode: "edit"; taskId: string; draft: TaskDraft }
  | null;

const todayIso = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};

const addDaysIso = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
};

function formatDate(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("he-IL").format(new Date(`${value}T00:00:00`));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function deviceTypeLabel(value: UserDevice["deviceType"]) {
  if (value === "mobile") return "נייד";
  if (value === "tablet") return "טאבלט";
  if (value === "desktop") return "מחשב";
  return "מכשיר";
}

function appOrigin() {
  if (typeof window === "undefined") return "http://localhost:3000";
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return window.location.origin;
  }
  return `${window.location.protocol}//${window.location.host}`;
}

function isTaskPrefix(value: unknown): value is TaskPrefix {
  return value === "P" || value === "W";
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && Object.keys(statusLabels).includes(value);
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && Object.keys(priorityLabels).includes(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeImportedTask(value: unknown): Task | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Record<string, unknown>;
  const id = typeof task.id === "string" ? canonicalTaskId(task.id) : null;
  const prefix = isTaskPrefix(task.prefix) ? task.prefix : id?.[0];
  const number = id ? Number(id.slice(1)) : Number.NaN;
  if (!id || !isTaskPrefix(prefix) || prefix !== id[0] || !Number.isInteger(number) || number <= 0) return null;
  if (typeof task.title !== "string" || !task.title.trim()) return null;
  if (typeof task.category !== "string" || !task.category.trim()) return null;
  if (!isTaskPriority(task.priority) || !isTaskStatus(task.status)) return null;

  return {
    id,
    prefix,
    number,
    title: task.title.trim(),
    category: task.category.trim(),
    actionType: optionalString(task.actionType),
    priority: task.priority,
    status: task.status,
    dueDate: optionalString(task.dueDate),
    createdAt: optionalString(task.createdAt),
    completedAt: optionalString(task.completedAt),
    notes: optionalString(task.notes),
  };
}

function getImportTasks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { tasks?: unknown }).tasks)) {
    return (value as { tasks: unknown[] }).tasks;
  }
  return [];
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "שגיאה לא ידועה";
}

function mergeUniqueTasks(tasks: Task[]) {
  return Array.from(new Map(tasks.map((task) => [task.id, task])).values())
    .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.number - b.number);
}

function defaultTaskDraft(prefix: TaskPrefix = "P"): TaskDraft {
  return {
    prefix,
    title: "",
    category: prefix === "W" ? "עבודה" : "אישי",
    actionType: "",
    priority: "normal",
    status: "open",
    dueDate: "",
    notes: "",
  };
}

function taskToDraft(task: Task): TaskDraft {
  return {
    prefix: task.prefix,
    title: task.title,
    category: task.category,
    actionType: task.actionType ?? "",
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate ?? "",
    notes: task.notes ?? "",
  };
}

function nextTaskNumber(tasks: Task[], prefix: TaskPrefix) {
  return Math.max(0, ...tasks.filter((task) => task.prefix === prefix).map((task) => task.number)) + 1;
}

let cachedTasksRaw: string | null | undefined;
let cachedTasks = initialTasks;
let activeTaskStorageKey = STORAGE_KEY;
const taskStoreListeners = new Set<() => void>();

function userTaskStorageKey(userId: string) {
  return `${STORAGE_KEY}:${userId}`;
}

function parseStoredTasks(raw: string | null, fallbackTasks: Task[]) {
  if (!raw) return fallbackTasks;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const imported = getImportTasks(parsed).map(normalizeImportedTask);
    if (imported.length === 0 && Array.isArray(parsed)) return [];
    if (imported.some((task) => !task)) return fallbackTasks;
    return mergeUniqueTasks(imported as Task[]);
  } catch {
    return fallbackTasks;
  }
}

function getTasksSnapshot() {
  if (typeof window === "undefined") return initialTasks;
  const raw = window.localStorage.getItem(activeTaskStorageKey);
  if (raw === cachedTasksRaw) return cachedTasks;
  cachedTasksRaw = raw;
  cachedTasks = parseStoredTasks(raw, activeTaskStorageKey === STORAGE_KEY ? initialTasks : []);
  return cachedTasks;
}

function getServerTasksSnapshot() {
  return initialTasks;
}

function subscribeTasks(listener: () => void) {
  taskStoreListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === activeTaskStorageKey) listener();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    taskStoreListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function writeTasks(nextTasks: Task[]) {
  const raw = JSON.stringify(nextTasks);
  cachedTasksRaw = raw;
  cachedTasks = nextTasks;
  window.localStorage.setItem(activeTaskStorageKey, raw);
  taskStoreListeners.forEach((listener) => listener());
}

function setTaskStorageUser(userId: string | null) {
  const nextKey = userId ? userTaskStorageKey(userId) : STORAGE_KEY;
  if (nextKey === activeTaskStorageKey) return;
  activeTaskStorageKey = nextKey;
  cachedTasksRaw = undefined;
  cachedTasks = userId ? [] : initialTasks;
  taskStoreListeners.forEach((listener) => listener());
}

function usePersistentTasks(): [Task[], Dispatch<SetStateAction<Task[]>>] {
  const tasks = useSyncExternalStore(subscribeTasks, getTasksSnapshot, getServerTasksSnapshot);
  const setTasks: Dispatch<SetStateAction<Task[]>> = useCallback((update) => {
    const nextTasks = typeof update === "function"
      ? (update as (current: Task[]) => Task[])(getTasksSnapshot())
      : update;
    writeTasks(nextTasks);
  }, []);
  return [tasks, setTasks];
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "he"));
}

function parseStoredTaxonomy(raw: string | null): TaskTaxonomy {
  if (!raw) return defaultTaxonomy;
  try {
    const parsed = JSON.parse(raw) as Partial<TaskTaxonomy>;
    return {
      topics: {
        P: uniqueSorted([...(defaultTaxonomy.topics.P), ...(parsed.topics?.P ?? [])]),
        W: uniqueSorted([...(defaultTaxonomy.topics.W), ...(parsed.topics?.W ?? [])]),
      },
      actions: uniqueSorted([...(defaultTaxonomy.actions), ...(parsed.actions ?? [])]),
    };
  } catch {
    return defaultTaxonomy;
  }
}

function mergeTaxonomies(...taxonomies: TaskTaxonomy[]): TaskTaxonomy {
  return {
    topics: {
      P: uniqueSorted(taxonomies.flatMap((taxonomy) => taxonomy.topics.P)),
      W: uniqueSorted(taxonomies.flatMap((taxonomy) => taxonomy.topics.W)),
    },
    actions: uniqueSorted(taxonomies.flatMap((taxonomy) => taxonomy.actions)),
  };
}

export default function Home() {
  const [tasks, setTasks] = usePersistentTasks();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("active");
  const [prefixFilter, setPrefixFilter] = useState<"all" | "P" | "W">("all");
  const [topicFilter, setTopicFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [activeView, setActiveView] = useState<MainView>("tasks");
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>("week");
  const [taxonomyMode, setTaxonomyMode] = useState<TaxonomyMode>("topics");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("sync");
  const [showClosedKanbanTasks, setShowClosedKanbanTasks] = useState(false);
  const [taxonomy, setTaxonomy] = useState<TaskTaxonomy>(defaultTaxonomy);
  const [taxonomyLoaded, setTaxonomyLoaded] = useState(false);
  const [taxonomyCloudReady, setTaxonomyCloudReady] = useState(false);
  const [taxonomyStatus, setTaxonomyStatus] = useState("נושאים ופעולות נשמרים מקומית עד להתחברות לענן.");
  const [newTopicPrefix, setNewTopicPrefix] = useState<TaskPrefix>("P");
  const [newTopicName, setNewTopicName] = useState("");
  const [newActionName, setNewActionName] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(false);
  const [cloudTaskCount, setCloudTaskCount] = useState<number | null>(null);
  const [lastCloudPullAt, setLastCloudPullAt] = useState<string | null>(null);
  const [cloudDevices, setCloudDevices] = useState<UserDevice[]>([]);
  const [devicesStatus, setDevicesStatus] = useState("");
  const [isCloudReady, setIsCloudReady] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [taskEditor, setTaskEditor] = useState<TaskEditorState>(null);
  const [taskEditorError, setTaskEditorError] = useState("");
  const [cloudStatus, setCloudStatus] = useState(
    isSupabaseConfigured ? "בודק חיבור ל-Supabase..." : "Supabase עדיין לא מוגדר. עובדים במצב מקומי."
  );

  const mergeCloudTasksIntoLocal = useCallback((cloudTasks: Task[]) => {
    const current = getTasksSnapshot();
    const merged = mergeUniqueTasks([...current, ...cloudTasks]);
    if (JSON.stringify(merged) !== JSON.stringify(current)) setTasks(merged);
  }, [setTasks]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setTaxonomy(parseStoredTaxonomy(window.localStorage.getItem(TAXONOMY_STORAGE_KEY)));
      setTaxonomyLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!taxonomyLoaded) return;
    window.localStorage.setItem(TAXONOMY_STORAGE_KEY, JSON.stringify(taxonomy));
  }, [taxonomy, taxonomyLoaded]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      setTaskStorageUser(user?.id ?? null);
      setCloudUser(user);
      setIsCloudReady(!user);
      setCloudStatus(user ? "טוען משימות מהענן..." : "לא מחובר. יש להתחבר כדי לראות את המשימות.");
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setTaskStorageUser(user?.id ?? null);
      setCloudUser(user);
      setCloudSyncEnabled(false);
      setCloudTaskCount(null);
      setLastCloudPullAt(null);
      setCloudDevices([]);
      setDevicesStatus("");
      setTaxonomyCloudReady(false);
      setTaxonomyStatus(user ? "טוען נושאים ופעולות מהענן..." : "נושאים ופעולות נשמרים מקומית עד להתחברות לענן.");
      setIsCloudReady(!user);
      setIsSettingsOpen(false);
      setTaskEditor(null);
      setCloudStatus(user ? "טוען משימות מהענן..." : "לא מחובר. יש להתחבר כדי לראות את המשימות.");
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!cloudUser || !taxonomyLoaded) return;

    let cancelled = false;

    fetchCloudTaxonomy()
      .then((cloudTaxonomy) => {
        if (cancelled) return;
        setTaxonomy(mergeTaxonomies(defaultTaxonomy, cloudTaxonomy));
        setTaxonomyCloudReady(true);
        setTaxonomyStatus("נושאים ופעולות מסונכרנים לענן.");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTaxonomyCloudReady(false);
        setTaxonomyStatus(`סנכרון נושאים ופעולות לא פעיל: ${errorMessage(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [cloudUser, taxonomyLoaded]);

  useEffect(() => {
    if (!cloudUser || !taxonomyCloudReady || !taxonomyLoaded) return;

    replaceCloudTaxonomy(taxonomy, cloudUser)
      .then(() => setTaxonomyStatus("נושאים ופעולות מסונכרנים לענן."))
      .catch((error: unknown) => setTaxonomyStatus(`שמירת נושאים ופעולות לענן נכשלה: ${errorMessage(error)}`));
  }, [cloudUser, taxonomy, taxonomyCloudReady, taxonomyLoaded]);

  useEffect(() => {
    if (!cloudUser) return;

    let cancelled = false;
    fetchCloudTasks()
      .then((cloudTasks) => {
        if (cancelled) return;
        if (cloudTasks.length > 0) {
          setTasks(mergeUniqueTasks(cloudTasks));
          setCloudTaskCount(cloudTasks.length);
          setCloudSyncEnabled(true);
          setLastCloudPullAt(new Date().toISOString());
          setCloudStatus(`מחובר לענן. נטענו ${cloudTasks.length} משימות.`);
        } else {
          setTasks([]);
          setCloudTaskCount(0);
          setCloudSyncEnabled(false);
          setLastCloudPullAt(new Date().toISOString());
          setCloudStatus("מחובר לענן, אבל עדיין אין משימות בענן. אפשר להעלות נתונים מקומיים מההגדרות.");
        }
        setIsCloudReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setIsCloudReady(true);
        setCloudStatus(`לא הצלחתי לטעון את המשימות מהענן: ${errorMessage(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [cloudUser, setTasks]);

  useEffect(() => {
    if (!cloudUser) return;

    let cancelled = false;

    async function refreshDevices() {
      if (!cloudUser) return;
      try {
        const currentDeviceId = await registerCurrentDevice(cloudUser);
        const devices = await fetchUserDevices(currentDeviceId);
        if (cancelled) return;
        setCloudDevices(devices);
        setDevicesStatus(`זוהו ${devices.length} מכשירים מחוברים לחשבון.`);
      } catch (error) {
        if (!cancelled) setDevicesStatus(`לא הצלחתי לעדכן את רשימת המכשירים: ${errorMessage(error)}`);
      }
    }

    refreshDevices();
    const intervalId = window.setInterval(refreshDevices, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [cloudUser]);

  useEffect(() => {
    if (!cloudUser || !cloudSyncEnabled || !isCloudReady) return;

    saveCloudTasks(tasks, cloudUser)
      .then(() => {
        setCloudTaskCount(tasks.length);
        setCloudStatus("המשימות מסונכרנות לענן.");
      })
      .catch((error: unknown) => setCloudStatus(`השמירה לענן נכשלה: ${errorMessage(error)}`));
  }, [cloudSyncEnabled, cloudUser, isCloudReady, tasks]);

  useEffect(() => {
    if (!cloudUser || !cloudSyncEnabled) return;

    let cancelled = false;

    async function refreshFromCloud() {
      if (document.visibilityState === "hidden") return;
      try {
        const cloudTasks = await fetchCloudTasks();
        if (cancelled) return;
        mergeCloudTasksIntoLocal(cloudTasks);
        setCloudTaskCount(cloudTasks.length);
        setLastCloudPullAt(new Date().toISOString());
      } catch (error) {
        if (!cancelled) setCloudStatus(`רענון אוטומטי מהענן נכשל: ${errorMessage(error)}`);
      }
    }

    const intervalId = window.setInterval(refreshFromCloud, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [cloudSyncEnabled, cloudUser, mergeCloudTasksIntoLocal]);

  const topicOptions = useMemo(() => ({
    P: uniqueSorted([...taxonomy.topics.P, ...tasks.filter((task) => task.prefix === "P").map((task) => task.category)]),
    W: uniqueSorted([...taxonomy.topics.W, ...tasks.filter((task) => task.prefix === "W").map((task) => task.category)]),
  }), [tasks, taxonomy]);

  const actionOptions = useMemo(() => (
    uniqueSorted([...taxonomy.actions, ...tasks.map((task) => task.actionType ?? "")])
  ), [tasks, taxonomy]);

  const filteredTasks = useMemo(() => {
    const normalized = canonicalTaskId(query);
    const today = todayIso();
    const weekEnd = addDaysIso(6);
    if (normalized) {
      return tasks
        .filter((task) => task.id === normalized)
        .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.number - b.number);
    }
    return tasks
      .filter((task) => prefixFilter === "all" || task.prefix === prefixFilter)
      .filter((task) => topicFilter === "all" || task.category === topicFilter)
      .filter((task) => actionFilter === "all" || (task.actionType ?? "") === actionFilter)
      .filter((task) => {
        if (statusFilter === "all") return true;
        if (statusFilter === "active") return !["done", "cancelled"].includes(task.status);
        if (statusFilter === "overdue") return Boolean(task.dueDate && task.dueDate < today && !["done", "cancelled"].includes(task.status));
        if (statusFilter === "today") return task.dueDate === today;
        if (statusFilter === "week") return Boolean(task.dueDate && task.dueDate >= today && task.dueDate <= weekEnd);
        if (statusFilter === "no_due") return !task.dueDate && !["done", "cancelled"].includes(task.status);
        if (statusFilter === "high") return task.priority === "high" && !["done", "cancelled"].includes(task.status);
        return task.status === statusFilter;
      })
      .filter((task) => {
        if (!query.trim()) return true;
        return `${task.id} ${task.title} ${task.category} ${task.actionType ?? ""} ${task.notes ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
      })
      .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.number - b.number);
  }, [tasks, query, statusFilter, prefixFilter, topicFilter, actionFilter]);

  const counts = useMemo(() => ({
    active: tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length,
    waiting: tasks.filter((t) => t.status === "waiting").length,
    done: tasks.filter((t) => t.status === "done").length,
  }), [tasks]);

  const statistics = useMemo(() => {
    const today = todayIso();
    const monthStartIso = `${today.slice(0, 7)}-01`;
    const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const done = tasks.filter((task) => task.status === "done");
    const completedWithDate = done.filter((task) => task.completedAt);

    return {
      total: tasks.length,
      active: active.length,
      done: done.length,
      overdue: active.filter((task) => Boolean(task.dueDate && task.dueDate < today)).length,
      withoutDueDate: active.filter((task) => !task.dueDate).length,
      completedThisMonth: completedWithDate.filter((task) => task.completedAt && task.completedAt >= monthStartIso).length,
      byStatus: Object.entries(statusLabels).map(([status, label]) => ({
        label,
        value: tasks.filter((task) => task.status === status).length,
      })),
    };
  }, [tasks]);

  const analytics = useMemo(() => {
    const today = todayIso();
    const weekStartIso = addDaysIso(-6);
    const monthStartIso = `${today.slice(0, 7)}-01`;
    const rangeStartIso = analyticsRange === "week" ? weekStartIso : analyticsRange === "month" ? monthStartIso : "";
    const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const done = tasks.filter((task) => task.status === "done");
    const completedWithDate = done.filter((task) => task.completedAt);
    const completedInRange = completedWithDate.filter((task) => !rangeStartIso || (task.completedAt && task.completedAt >= rangeStartIso));
    const completedLast7 = completedWithDate.filter((task) => task.completedAt && task.completedAt >= weekStartIso).length;
    const completedLast30 = completedWithDate.filter((task) => task.completedAt && task.completedAt >= addDaysIso(-29)).length;
    const overdue = active.filter((task) => Boolean(task.dueDate && task.dueDate < today));
    const waiting = active.filter((task) => task.status === "waiting");
    const withoutDueDate = active.filter((task) => !task.dueDate);
    const highPriority = active.filter((task) => task.priority === "high");
    const attentionMap = new Map<string, Task>();
    const addAttention = (source: Task[]) => source.forEach((task) => {
      if (!attentionMap.has(task.id)) attentionMap.set(task.id, task);
    });

    addAttention([...overdue].sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.number - b.number));
    addAttention([...highPriority].sort((a, b) => a.number - b.number));
    addAttention([...waiting].sort((a, b) => a.number - b.number));
    addAttention([...withoutDueDate].sort((a, b) => a.number - b.number));

    const activeCategories = Array.from(new Set(active.map((task) => task.category))).map((category) => ({
      label: category,
      value: active.filter((task) => task.category === category).length,
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const topCategory = activeCategories[0];
    const stuckTasks = active
      .filter((task) => task.status === "waiting" || Boolean(task.dueDate && task.dueDate < addDaysIso(-7)))
      .sort((a, b) => (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") || a.number - b.number);
    const insights: AnalyticsInsight[] = [];

    if (overdue.length > 0) {
      insights.push({
        id: "overdue",
        title: `${overdue.length} משימות באיחור`,
        body: "כדאי להתחיל מהן לפני הוספת משימות חדשות, כדי להוריד עומס פתוח.",
        tone: "danger",
        actionLabel: "הצג באיחור",
        action: { statusFilter: "overdue" },
      });
    } else if (active.length > 0) {
      insights.push({
        id: "no-overdue",
        title: "אין משימות באיחור",
        body: "מצב טוב. אפשר להתמקד במשימות בעדיפות גבוהה או בממתינות.",
        tone: "good",
        actionLabel: highPriority.length > 0 ? "הצג גבוהה" : "הצג פעילות",
        action: { statusFilter: highPriority.length > 0 ? "high" : "active" },
      });
    }

    if (topCategory && topCategory.value >= 3) {
      insights.push({
        id: "top-category",
        title: `עומס מרכזי בנושא ${topCategory.label}`,
        body: `${topCategory.value} משימות פעילות מרוכזות שם. זה כנראה המקום שבו מיקוד קצר ייתן הכי הרבה ערך.`,
        tone: "warn",
        actionLabel: "פתח נושא",
        action: { statusFilter: "active", topicFilter: topCategory.label },
      });
    }

    if (withoutDueDate.length > 0) {
      insights.push({
        id: "without-due-date",
        title: `${withoutDueDate.length} משימות בלי תאריך יעד`,
        body: "לא חייבים לתארך הכול, אבל כדאי לתת יעד למשימות שצריכות לזוז השבוע.",
        tone: "neutral",
        actionLabel: "הצג בלי יעד",
        action: { statusFilter: "no_due" },
      });
    }

    if (waiting.length > 0) {
      insights.push({
        id: "waiting",
        title: `${waiting.length} משימות ממתינות`,
        body: "שווה לבדוק מי הגורם החוסם ולסגור לולאה קצרה במקום לתת לזה להישאר פתוח.",
        tone: "warn",
        actionLabel: "הצג ממתינות",
        action: { statusFilter: "waiting" },
      });
    }

    insights.push({
      id: "completion-rate",
      title: `${completedLast7} נסגרו השבוע, ${completedLast30} ב-30 יום`,
      body: completedLast7 > 0
        ? "יש תנועה קדימה. המדד הזה יעזור לזהות בהמשך אם הקצב יורד או עולה."
        : "השבוע עוד לא נסגרו משימות. אפשר לבחור משימה קטנה אחת ולייצר התקדמות מהירה.",
      tone: completedLast7 > 0 ? "good" : "neutral",
      actionLabel: completedLast7 > 0 ? "הצג הושלמו" : "הצג פעילות",
      action: { statusFilter: completedLast7 > 0 ? "done" : "active" },
    });

    if (stuckTasks.length > 0) {
      insights.push({
        id: "stuck",
        title: "יש משימות שנראות תקועות",
        body: `${stuckTasks.length} משימות ממתינות או עם יעד ישן. כדאי לבחור אחת ולהחליט: לקדם, לעדכן יעד או לסגור.`,
        tone: "danger",
        actionLabel: "פתח ראשונה",
        action: { query: stuckTasks[0].id, statusFilter: "all" },
      });
    }

    return {
      completedInRange: completedInRange.length,
      completionTrend: Array.from({ length: 7 }, (_, index) => {
        const date = addDaysIso(index - 6);
        return {
          date,
          label: new Intl.DateTimeFormat("he-IL", { weekday: "short" }).format(new Date(`${date}T00:00:00`)),
          value: completedWithDate.filter((task) => task.completedAt === date).length,
        };
      }),
      waiting: waiting.length,
      byCategory: activeCategories,
      attention: Array.from(attentionMap.values()).slice(0, 8),
      insights: insights.slice(0, 5),
    };
  }, [analyticsRange, tasks]);

  function maxValue(rows: StatRow[]) {
    return Math.max(1, ...rows.map((row) => row.value));
  }

  function maxTrendValue() {
    return Math.max(1, ...analytics.completionTrend.map((row) => row.value));
  }

  function analyticsRangeLabel() {
    if (analyticsRange === "week") return "7 ימים";
    if (analyticsRange === "month") return "חודש";
    return "הכול";
  }

  function attentionReason(task: Task) {
    if (isOverdue(task)) return "באיחור";
    if (task.priority === "high" && !["done", "cancelled"].includes(task.status)) return "גבוהה";
    if (task.status === "waiting") return "ממתינה";
    if (!task.dueDate && !["done", "cancelled"].includes(task.status)) return "בלי יעד";
    return statusLabels[task.status];
  }

  function focusTask(taskId: string) {
    setQuery(taskId);
    setStatusFilter("all");
    setPrefixFilter("all");
    setActiveView("tasks");
  }

  function applyInsightAction(insight: AnalyticsInsight) {
    if (!insight.action) return;
    setQuery(insight.action.query ?? "");
    setStatusFilter(insight.action.statusFilter ?? "active");
    setPrefixFilter("all");
    setActionFilter("all");
    setTopicFilter(insight.action.topicFilter ?? "all");
    setActiveView("tasks");
  }

  function updateStatus(id: string, status: TaskStatus) {
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      return {
        ...task,
        status,
        completedAt: status === "done" ? task.completedAt ?? todayIso() : undefined,
      };
    }));
  }

  function isOverdue(task: Task) {
    return Boolean(task.dueDate && !["done", "cancelled"].includes(task.status) && task.dueDate < todayIso());
  }

  function openCreateTask() {
    setTaskEditorError("");
    setTaskEditor({ mode: "create", draft: defaultTaskDraft(prefixFilter === "W" ? "W" : "P") });
  }

  function openEditTask(task: Task) {
    setTaskEditorError("");
    setTaskEditor({ mode: "edit", taskId: task.id, draft: taskToDraft(task) });
  }

  function updateTaskDraft(updates: Partial<TaskDraft>) {
    setTaskEditor((current) => current ? { ...current, draft: { ...current.draft, ...updates } } : current);
  }

  function closeTaskEditor() {
    setTaskEditor(null);
    setTaskEditorError("");
  }

  function saveTaskEditor(event: FormEvent) {
    event.preventDefault();
    if (!taskEditor) return;

    const draft = taskEditor.draft;
    const title = draft.title.trim();
    const category = draft.category.trim();
    if (!title) {
      setTaskEditorError("יש למלא שם משימה.");
      return;
    }
    if (!category) {
      setTaskEditorError("יש למלא קטגוריה.");
      return;
    }

    setTasks((current) => {
      if (taskEditor.mode === "create") {
        const nextNumber = nextTaskNumber(current, draft.prefix);
        return mergeUniqueTasks([...current, {
          id: `${draft.prefix}${nextNumber}`,
          prefix: draft.prefix,
          number: nextNumber,
          title,
          category,
          actionType: draft.actionType.trim() || undefined,
          priority: draft.priority,
          status: draft.status,
          dueDate: draft.dueDate || undefined,
          notes: draft.notes.trim() || undefined,
          createdAt: todayIso(),
          completedAt: draft.status === "done" ? todayIso() : undefined,
        }]);
      }

      return current.map((task) => {
        if (task.id !== taskEditor.taskId) return task;
        return {
          ...task,
          title,
          category,
          actionType: draft.actionType.trim() || undefined,
          priority: draft.priority,
          status: draft.status,
          dueDate: draft.dueDate || undefined,
          notes: draft.notes.trim() || undefined,
          completedAt: draft.status === "done" ? task.completedAt ?? todayIso() : undefined,
        };
      });
    });

    closeTaskEditor();
  }

  function addTopic(event: FormEvent) {
    event.preventDefault();
    const name = newTopicName.trim();
    if (!name) return;
    setTaxonomy((current) => ({
      ...current,
      topics: {
        ...current.topics,
        [newTopicPrefix]: uniqueSorted([...current.topics[newTopicPrefix], name]),
      },
    }));
    setNewTopicName("");
  }

  function removeTopic(prefix: TaskPrefix, topic: string) {
    setTaxonomy((current) => ({
      ...current,
      topics: {
        ...current.topics,
        [prefix]: current.topics[prefix].filter((value) => value !== topic),
      },
    }));
  }

  function addAction(event: FormEvent) {
    event.preventDefault();
    const name = newActionName.trim();
    if (!name) return;
    setTaxonomy((current) => ({
      ...current,
      actions: uniqueSorted([...current.actions, name]),
    }));
    setNewActionName("");
  }

  function removeAction(action: string) {
    setTaxonomy((current) => ({
      ...current,
      actions: current.actions.filter((value) => value !== action),
    }));
  }

  function resetDataWithConfirmation() {
    if (cloudUser) {
      setImportMessage("האיפוס נחסם כי החשבון מחובר לענן. כדי להגן על הנתונים, התנתק מ-Supabase לפני איפוס לרשימת הבסיס.");
      return;
    }
    const approved = window.confirm("איפוס יחזיר את רשימת המשימות המקומית לרשימת הבסיס. מומלץ לייצא גיבוי לפני הפעולה. להמשיך?");
    if (!approved) return;
    const typed = window.prompt("כדי לאשר איפוס, הקלד בדיוק: איפוס");
    if (typed !== "איפוס") {
      setImportMessage("האיפוס בוטל. לא הוקלדה מילת האישור.");
      return;
    }
    setTasks(initialTasks);
    setImportMessage("האיפוס המקומי בוצע.");
  }

  function exportData() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `asaf-task-tracker-${todayIso()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setImportMessage("קובץ הגיבוי נוצר והורד למחשב.");
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const imported = getImportTasks(parsed).map(normalizeImportedTask);
      const validTasks = imported.filter((task): task is Task => Boolean(task));
      const summary: ImportSummary = { added: 0, updated: 0, skipped: imported.length - validTasks.length };

      setTasks((current) => {
        const merged = new Map(current.map((task) => [task.id, task]));
        for (const task of validTasks) {
          if (merged.has(task.id)) summary.updated += 1;
          else summary.added += 1;
          merged.set(task.id, task);
        }
        return mergeUniqueTasks(Array.from(merged.values()));
      });

      setImportMessage(`הייבוא הושלם: ${summary.added} נוספו, ${summary.updated} עודכנו, ${summary.skipped} דולגו.`);
    } catch {
      setImportMessage("לא הצלחתי לקרוא את הקובץ. יש לבחור קובץ JSON תקין של האפליקציה.");
    }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!supabase) {
      setCloudStatus("Supabase עדיין לא מוגדר. יש למלא את .env.local.");
      return;
    }

    const email = authEmail.trim();
    if (!email) return;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: appOrigin(),
      },
    });

    setCloudStatus(error ? `שליחת קישור ההתחברות נכשלה: ${error.message}` : "נשלח קישור התחברות למייל.");
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setTaskStorageUser(null);
    setCloudUser(null);
    setCloudSyncEnabled(false);
    setLastCloudPullAt(null);
    setCloudDevices([]);
    setDevicesStatus("");
    setTaxonomyCloudReady(false);
    setTaxonomyStatus("נושאים ופעולות נשמרים מקומית עד להתחברות לענן.");
    setIsCloudReady(true);
    setIsSettingsOpen(false);
    setTaskEditor(null);
    setCloudStatus("התנתקת. יש להתחבר כדי לראות את המשימות.");
  }

  async function uploadLocalToCloud() {
    if (!cloudUser) {
      setCloudStatus("צריך להתחבר לפני העלאה לענן.");
      return;
    }

    try {
      await saveCloudTasks(tasks, cloudUser);
      setCloudSyncEnabled(true);
      setCloudTaskCount(tasks.length);
      setCloudStatus(`הועלו ${tasks.length} משימות לענן והסנכרון הופעל.`);
    } catch (error) {
      setCloudStatus(`העלאה לענן נכשלה: ${errorMessage(error)}. הנתונים המקומיים לא נמחקו.`);
    }
  }

  async function pullCloudToLocal() {
    if (!cloudUser) {
      setCloudStatus("צריך להתחבר לפני משיכת נתונים מהענן.");
      return;
    }

    try {
      const cloudTasks = await fetchCloudTasks();
      mergeCloudTasksIntoLocal(cloudTasks);
      setCloudSyncEnabled(true);
      setCloudTaskCount(cloudTasks.length);
      setLastCloudPullAt(new Date().toISOString());
      setCloudStatus(`נמשכו ${cloudTasks.length} משימות מהענן ומוזגו עם המכשיר הזה.`);
    } catch (error) {
      setCloudStatus(`משיכת הנתונים מהענן נכשלה: ${errorMessage(error)}`);
    }
  }

  async function refreshCloudCount() {
    if (!cloudUser) {
      setCloudStatus("צריך להתחבר לפני בדיקת המונה בענן.");
      return;
    }

    try {
      const count = await countCloudTasks();
      setCloudTaskCount(count);
      setCloudStatus(`מונה הענן עודכן: ${count} משימות.`);
    } catch (error) {
      setCloudStatus(`לא הצלחתי לעדכן את מונה הענן: ${errorMessage(error)}`);
    }
  }

  async function refreshCloudDevices() {
    if (!cloudUser) {
      setDevicesStatus("צריך להתחבר לפני בדיקת מכשירים מחוברים.");
      return;
    }

    try {
      const currentDeviceId = await registerCurrentDevice(cloudUser);
      const devices = await fetchUserDevices(currentDeviceId);
      setCloudDevices(devices);
      setDevicesStatus(`רשימת המכשירים עודכנה: ${devices.length} מכשירים.`);
    } catch (error) {
      setDevicesStatus(`לא הצלחתי לעדכן את רשימת המכשירים: ${errorMessage(error)}`);
    }
  }

  return (
    <main className={activeView === "kanban" ? "kanban-main" : undefined}>
      <header className="hero">
        <div>
          <p className="eyebrow">מעקב משימות אישי</p>
          <h1>המשימות שלי</h1>
          <p className="subtitle">ניהול פשוט, עקבי ונגיש מכל מכשיר</p>
        </div>
        {cloudUser && (
          <button className="settings-button" onClick={() => setIsSettingsOpen(true)} aria-label="פתיחת הגדרות">
            <span aria-hidden="true">⚙</span>
            הגדרות
          </button>
        )}
      </header>

      {!cloudUser ? (
        <section className="auth-gate" aria-label="התחברות">
          <div className="panel auth-panel">
            <div>
              <p className="eyebrow">אזור פרטי</p>
              <h2>התחברות למעקב המשימות</h2>
              <p>כדי לשמור על פרטיות, המשימות מוצגות רק אחרי התחברות לחשבון שלך.</p>
            </div>
            {isSupabaseConfigured ? (
              <form className="auth-form" onSubmit={signIn}>
                <label>
                  <span>כתובת מייל</span>
                  <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="name@example.com" aria-label="כתובת מייל להתחברות" />
                </label>
                <button type="submit">שליחת קישור התחברות</button>
              </form>
            ) : (
              <code>NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>
            )}
            <p className="auth-status">{cloudStatus}</p>
          </div>
        </section>
      ) : !isCloudReady ? (
        <section className="panel loading-panel" aria-live="polite">
          <h2>טוען את המשימות שלך</h2>
          <p>{cloudStatus}</p>
        </section>
      ) : (
        <>
          <section className="stats" aria-label="סיכום משימות">
            <button onClick={() => { setStatusFilter("active"); setActiveView("tasks"); }}><strong>{counts.active}</strong><span>פעילות</span></button>
            <button onClick={() => { setStatusFilter("waiting"); setActiveView("tasks"); }}><strong>{counts.waiting}</strong><span>ממתינות</span></button>
            <button onClick={() => { setStatusFilter("done"); setActiveView("tasks"); }}><strong>{counts.done}</strong><span>הושלמו</span></button>
          </section>

          <nav className="view-tabs" aria-label="מעבר בין תצוגות">
            <button className={activeView === "tasks" ? "active" : ""} onClick={() => setActiveView("tasks")}>משימות</button>
            <button className={activeView === "kanban" ? "active" : ""} onClick={() => setActiveView("kanban")}>לוח Kanban</button>
            <button className={activeView === "stats" ? "active" : ""} onClick={() => setActiveView("stats")}>סטטיסטיקות</button>
          </nav>

          {activeView === "tasks" ? (
            <>
              <section className="panel controls">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="חיפוש משימה או מזהה, למשל P19" aria-label="חיפוש" />
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="סינון סטטוס">
                  <option value="active">משימות פעילות</option>
                  <option value="open">פתוחות</option>
                  <option value="in_progress">בטיפול</option>
                  <option value="waiting">ממתינות</option>
                  <option value="done">בוצעו</option>
                  <option value="cancelled">בוטלו</option>
                  <option value="all">הכול</option>
                </select>
                <select value={prefixFilter} onChange={(e) => setPrefixFilter(e.target.value as typeof prefixFilter)} aria-label="סינון סוג">
                  <option value="all">אישי ועבודה</option>
                  <option value="P">אישי בלבד</option>
                  <option value="W">עבודה בלבד</option>
                </select>
                <select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)} aria-label="סינון נושא">
                  <option value="all">כל הנושאים</option>
                  {uniqueSorted([...topicOptions.P, ...topicOptions.W]).map((topic) => <option value={topic} key={topic}>{topic}</option>)}
                </select>
                <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} aria-label="סינון פעולה">
                  <option value="all">כל הפעולות</option>
                  {actionOptions.map((action) => <option value={action} key={action}>{action}</option>)}
                </select>
              </section>

              <section className="quick-filters" aria-label="סינון מהיר">
                <button className={statusFilter === "today" ? "active" : ""} onClick={() => setStatusFilter("today")}>להיום</button>
                <button className={statusFilter === "week" ? "active" : ""} onClick={() => setStatusFilter("week")}>השבוע</button>
                <button className={statusFilter === "overdue" ? "active" : ""} onClick={() => setStatusFilter("overdue")}>באיחור</button>
                <button className={statusFilter === "no_due" ? "active" : ""} onClick={() => setStatusFilter("no_due")}>בלי יעד</button>
                <button className={statusFilter === "high" ? "active" : ""} onClick={() => setStatusFilter("high")}>גבוהה</button>
              </section>

              <section className="task-list" aria-live="polite">
                {filteredTasks.length === 0 && <div className="empty">לא נמצאו משימות מתאימות.</div>}
                {filteredTasks.map((task) => (
                  <article className={`task-card status-${task.status}${isOverdue(task) ? " is-overdue" : ""}`} key={task.id}>
                    <button className="check" aria-label={`סימון ${task.title} כבוצעה`} onClick={() => updateStatus(task.id, task.status === "done" ? "open" : "done")}>
                      {task.status === "done" ? "✓" : ""}
                    </button>
                    <div className="task-main">
                      <div className="task-heading">
                        <span className="task-id">{task.id}</span>
                        <h2>{task.title}</h2>
                      </div>
                      <div className="meta">
                        <span>נושא {task.category}</span>
                        {task.actionType && <span>פעולה {task.actionType}</span>}
                        <span>עדיפות {priorityLabels[task.priority]}</span>
                        {task.dueDate && <span>יעד {formatDate(task.dueDate)}</span>}
                        {task.completedAt && <span>נסגרה {formatDate(task.completedAt)}</span>}
                      </div>
                      {task.notes && <p className="task-notes">{task.notes}</p>}
                    </div>
                    <div className="task-actions">
                      <select value={task.status} onChange={(e) => updateStatus(task.id, e.target.value as TaskStatus)} aria-label={`סטטוס ${task.title}`}>
                        {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                      </select>
                      <button onClick={() => openEditTask(task)}>עריכה</button>
                    </div>
                  </article>
                ))}
              </section>

              <button className="floating-add" onClick={openCreateTask} aria-label="הוספת משימה חדשה">+</button>
            </>
          ) : activeView === "kanban" ? (
            <>
              <div className="kanban-toolbar">
                <div>
                  <h2>לוח עבודה פעיל</h2>
                  <p>כברירת מחדל מוצגות רק משימות פתוחות, בטיפול או בהמתנה.</p>
                </div>
                <label className="toggle-control">
                  <input
                    type="checkbox"
                    checked={showClosedKanbanTasks}
                    onChange={(event) => setShowClosedKanbanTasks(event.target.checked)}
                  />
                  <span>הצג משימות סגורות</span>
                </label>
              </div>
              <section className="kanban-board" aria-label="לוח Kanban">
                {(showClosedKanbanTasks ? kanbanStatuses : activeKanbanStatuses).map((status) => {
                  const columnTasks = filteredTasks.filter((task) => task.status === status);
                  return (
                    <section className="kanban-column" key={status}>
                      <div className="kanban-column-header">
                        <h2>{statusLabels[status]}</h2>
                        <span>{columnTasks.length}</span>
                      </div>
                      <div className="kanban-list">
                        {columnTasks.length === 0 ? (
                          <p className="kanban-empty">אין משימות</p>
                        ) : columnTasks.map((task) => (
                          <article className={`kanban-card status-${task.status}${isOverdue(task) ? " is-overdue" : ""}`} key={task.id}>
                            <div className="task-heading">
                              <span className="task-id">{task.id}</span>
                              <h3>{task.title}</h3>
                            </div>
                            <div className="meta">
                              <span>נושא {task.category}</span>
                              {task.actionType && <span>פעולה {task.actionType}</span>}
                              <span>עדיפות {priorityLabels[task.priority]}</span>
                              {task.dueDate && <span>יעד {formatDate(task.dueDate)}</span>}
                            </div>
                            <div className="kanban-actions">
                              <select value={task.status} onChange={(event) => updateStatus(task.id, event.target.value as TaskStatus)} aria-label={`סטטוס ${task.title}`}>
                                {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                              </select>
                              <button onClick={() => openEditTask(task)}>עריכה</button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </section>
              <button className="floating-add" onClick={openCreateTask} aria-label="הוספת משימה חדשה">+</button>
            </>
          ) : (
            <section className="stats-view analytics-upgraded" aria-label="סטטיסטיקות משימות">
              <div className="analytics-header">
                <div>
                  <h2>תמונת מצב</h2>
                  <p>מדדים, קצב סגירה ומשימות שדורשות תשומת לב.</p>
                </div>
                <div className="range-tabs" aria-label="טווח סטטיסטיקות">
                  <button className={analyticsRange === "week" ? "active" : ""} onClick={() => setAnalyticsRange("week")}>7 ימים</button>
                  <button className={analyticsRange === "month" ? "active" : ""} onClick={() => setAnalyticsRange("month")}>חודש</button>
                  <button className={analyticsRange === "all" ? "active" : ""} onClick={() => setAnalyticsRange("all")}>הכול</button>
                </div>
              </div>

              <section className="panel insights-panel" aria-label="תובנות מרכזיות">
                <div className="panel-heading">
                  <div>
                    <h2>תובנות מרכזיות</h2>
                    <span>מיידי, שבועי וכללי לפי מצב המשימות הנוכחי</span>
                  </div>
                </div>
                <div className="insights-grid">
                  {analytics.insights.map((insight) => (
                    <article className={`insight-card insight-${insight.tone}`} key={insight.id}>
                      <div>
                        <h3>{insight.title}</h3>
                        <p>{insight.body}</p>
                      </div>
                      {insight.action && insight.actionLabel && (
                        <button onClick={() => applyInsightAction(insight)}>{insight.actionLabel}</button>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              <div className="metric-grid analytics-metrics">
                <div className="metric"><span>פעילות</span><strong>{statistics.active}</strong><small>פתוחות, בטיפול או ממתינות</small></div>
                <div className="metric metric-danger"><span>באיחור</span><strong>{statistics.overdue}</strong><small>דורשות החלטה</small></div>
                <div className="metric metric-warn"><span>ממתינות</span><strong>{analytics.waiting}</strong><small>תקועות על גורם חיצוני</small></div>
                <div className="metric"><span>בלי תאריך יעד</span><strong>{statistics.withoutDueDate}</strong><small>כדאי למקד</small></div>
                <div className="metric metric-good"><span>נסגרו בטווח</span><strong>{analytics.completedInRange}</strong><small>{analyticsRangeLabel()}</small></div>
                <div className="metric"><span>כל המשימות</span><strong>{statistics.total}</strong><small>{statistics.done} הושלמו</small></div>
              </div>

              <div className="analytics-layout">
                <div className="analytics-main">
                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>קצב סגירה - 7 ימים אחרונים</h2>
                      <span>משימות שהושלמו לפי יום</span>
                    </div>
                    <div className="week-chart" aria-label="קצב סגירה שבועי">
                      {analytics.completionTrend.map((row) => (
                        <div className="day-column" key={row.date}>
                          <div className="vertical-track"><div style={{ height: `${(row.value / maxTrendValue()) * 100}%` }} /></div>
                          <strong>{row.value}</strong>
                          <span>{row.label}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>איפה מצטבר עומס</h2>
                      <span>נושאים פעילים</span>
                    </div>
                    {analytics.byCategory.length === 0 ? (
                      <p className="muted-line">אין כרגע נושאים פעילים.</p>
                    ) : analytics.byCategory.slice(0, 8).map((row) => (
                      <div className="bar-row" key={row.label}>
                        <span>{row.label}</span>
                        <div className="bar-track"><div style={{ width: `${(row.value / maxValue(analytics.byCategory)) * 100}%` }} /></div>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </section>

                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>חלוקה לפי סטטוס</h2>
                      <span>כל המשימות</span>
                    </div>
                    {statistics.byStatus.map((row) => (
                      <div className="bar-row" key={row.label}>
                        <span>{row.label}</span>
                        <div className="bar-track"><div style={{ width: `${(row.value / maxValue(statistics.byStatus)) * 100}%` }} /></div>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </section>
                </div>

                <aside className="panel attention-panel">
                  <div className="panel-heading">
                    <h2>דורש תשומת לב</h2>
                    <span>לחיצה מעבירה למשימה ברשימה</span>
                  </div>
                  <div className="attention-list">
                    {analytics.attention.length === 0 ? (
                      <p className="muted-line">אין כרגע משימות שדורשות תשומת לב מיוחדת.</p>
                    ) : analytics.attention.map((task) => (
                      <button className={`attention-task${isOverdue(task) ? " overdue" : ""}`} key={task.id} onClick={() => focusTask(task.id)}>
                        <span className="attention-top">
                          <span className="task-id">{task.id}</span>
                          <span className="attention-tag">{attentionReason(task)}</span>
                        </span>
                        <strong>{task.title}</strong>
                        <span>{task.category}{task.actionType ? ` · ${task.actionType}` : ""} · עדיפות {priorityLabels[task.priority]}{task.dueDate ? ` · יעד ${formatDate(task.dueDate)}` : ""}</span>
                      </button>
                    ))}
                  </div>
                </aside>
              </div>
            </section>
          )}
        </>
      )}

      {isSettingsOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="settings-drawer" role="dialog" aria-modal="true" aria-label="הגדרות">
            <div className="drawer-header">
              <div>
                <p className="eyebrow">הגדרות</p>
                <h2>{settingsTab === "taxonomy" ? "נושאים ופעולות" : "חיבור, סנכרון וגיבוי"}</h2>
              </div>
              <button className="icon-button" onClick={() => setIsSettingsOpen(false)} aria-label="סגירת הגדרות">×</button>
            </div>

            <div className="settings-tabs" aria-label="אזורי הגדרות">
              <button className={settingsTab === "taxonomy" ? "active" : ""} onClick={() => setSettingsTab("taxonomy")}>
                נושאים ופעולות
              </button>
              <button className={settingsTab === "sync" ? "active" : ""} onClick={() => setSettingsTab("sync")}>
                חיבור, סנכרון וגיבוי
              </button>
            </div>

            <section className="data-view" aria-label="גיבוי ושחזור נתונים">
              {settingsTab === "taxonomy" ? (
              <section className="panel taxonomy-panel">
                <div className="panel-heading">
                  <div>
                    <h2>נושאים ופעולות</h2>
                    <span>ניהול שיוכים פנימיים בלי לשנות את מזהי P/W.</span>
                  </div>
                  <div className="range-tabs">
                    <button className={taxonomyMode === "topics" ? "active" : ""} onClick={() => setTaxonomyMode("topics")}>נושאים</button>
                    <button className={taxonomyMode === "actions" ? "active" : ""} onClick={() => setTaxonomyMode("actions")}>פעולות</button>
                  </div>
                </div>
                <p className="taxonomy-status">{taxonomyStatus}</p>

                {taxonomyMode === "topics" ? (
                  <div className="taxonomy-manager">
                    <form className="taxonomy-form" onSubmit={addTopic}>
                      <select value={newTopicPrefix} onChange={(event) => setNewTopicPrefix(event.target.value as TaskPrefix)} aria-label="סוג נושא">
                        <option value="P">אישי</option>
                        <option value="W">עבודה</option>
                      </select>
                      <input value={newTopicName} onChange={(event) => setNewTopicName(event.target.value)} placeholder="שם נושא חדש" aria-label="שם נושא חדש" />
                      <button type="submit">הוספת נושא</button>
                    </form>
                    <div className="taxonomy-grid">
                      {(["P", "W"] as TaskPrefix[]).map((prefix) => (
                        <section className="taxonomy-group" key={prefix}>
                          <h3>{prefix === "P" ? "אישי" : "עבודה"}</h3>
                          <div className="taxonomy-chips">
                            {topicOptions[prefix].map((topic) => (
                              <span className="taxonomy-chip" key={topic}>
                                {topic}
                                <button onClick={() => removeTopic(prefix, topic)} aria-label={`מחיקת נושא ${topic}`}>×</button>
                              </span>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="taxonomy-manager">
                    <form className="taxonomy-form" onSubmit={addAction}>
                      <input value={newActionName} onChange={(event) => setNewActionName(event.target.value)} placeholder="שם פעולה חדשה" aria-label="שם פעולה חדשה" />
                      <button type="submit">הוספת פעולה</button>
                    </form>
                    <div className="taxonomy-chips">
                      {actionOptions.map((action) => (
                        <span className="taxonomy-chip" key={action}>
                          {action}
                          <button onClick={() => removeAction(action)} aria-label={`מחיקת פעולה ${action}`}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              ) : (
              <>

              <section className="panel cloud-panel">
                <div>
                  <h2>חיבור Supabase</h2>
                  <p>{cloudStatus}</p>
                  {cloudUser && <p className="cloud-user">מחובר: {cloudUser.email}</p>}
                  {cloudUser && (
                    <div className="sync-counters" aria-label="מונה סנכרון">
                      <span>מקומי: <strong>{tasks.length}</strong></span>
                      <span>ענן: <strong>{cloudTaskCount ?? "לא נבדק"}</strong></span>
                    </div>
                  )}
                </div>
                {isSupabaseConfigured ? (
                  cloudUser ? (
                    <div className="cloud-actions">
                      {!cloudSyncEnabled && <button onClick={uploadLocalToCloud}>העלאת הנתונים המקומיים לענן</button>}
                      <button onClick={refreshCloudCount}>רענון מונה</button>
                      <button className="secondary-action" onClick={signOut}>התנתקות</button>
                    </div>
                  ) : (
                    <form className="cloud-login" onSubmit={signIn}>
                      <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="כתובת מייל להתחברות" aria-label="כתובת מייל להתחברות" />
                      <button type="submit">שליחת קישור</button>
                    </form>
                  )
                ) : (
                  <code>NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>
                )}
              </section>

              {cloudUser && (
                <section className="panel sync-panel">
                  <div>
                    <h2>סנכרון בין מכשירים</h2>
                    <p>האפליקציה מושכת עדכונים מהענן אוטומטית פעם בדקה כשהמסך פתוח.</p>
                    {lastCloudPullAt && <p>משיכה אחרונה: {formatDateTime(lastCloudPullAt)}</p>}
                  </div>
                  <button onClick={pullCloudToLocal}>משיכת נתונים מהענן</button>
                </section>
              )}

              {cloudUser && (
                <section className="panel devices-panel">
                  <div className="devices-header">
                    <div>
                      <h2>מכשירים מחוברים</h2>
                      <p>{devicesStatus || "בודק מכשירים שמחוברים לחשבון הזה."}</p>
                    </div>
                    <button onClick={refreshCloudDevices}>רענון מכשירים</button>
                  </div>
                  <div className="devices-list" aria-label="מכשירים מחוברים">
                    {cloudDevices.length === 0 ? (
                      <p className="devices-empty">עדיין אין נתוני מכשירים להצגה.</p>
                    ) : cloudDevices.map((device) => (
                      <article className="device-card" key={device.deviceId}>
                        <div>
                          <h3>{device.deviceName}</h3>
                          <p>{deviceTypeLabel(device.deviceType)} · {device.browserName}</p>
                        </div>
                        <div className="device-meta">
                          {device.isCurrent && <span className="current-device">המכשיר הזה</span>}
                          <span>נראה לאחרונה: {formatDateTime(device.lastSeenAt)}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <section className="panel data-panel">
                <div>
                  <h2>גיבוי מקומי</h2>
                  <p>ייצוא כל המשימות לקובץ JSON כולל סטטוסים, תאריכי יעד, הערות ותאריכי סגירה.</p>
                </div>
                <button onClick={exportData}>ייצוא קובץ גיבוי</button>
              </section>

              <section className="panel data-panel">
                <div>
                  <h2>שחזור במיזוג</h2>
                  <p>ייבוא מקובץ JSON יעדכן משימות לפי מזהה ויוסיף משימות חסרות. הוא לא מוחק משימות שלא קיימות בקובץ.</p>
                </div>
                <label className="file-button">
                  בחירת קובץ JSON
                  <input type="file" accept="application/json,.json" onChange={importData} />
                </label>
              </section>

              {importMessage && <p className="import-message">{importMessage}</p>}

              <section className="panel danger-panel">
                <div>
                  <h2>איפוס לרשימת הבסיס</h2>
                  <p>פעולה זו מחזירה את רשימת המשימות ההתחלתית של הפרויקט. כדאי לייצא גיבוי לפני שימוש בה.</p>
                </div>
                <button onClick={resetDataWithConfirmation}>איפוס נתוני ניסיון</button>
              </section>
              </>
              )}
            </section>
          </section>
        </div>
      )}

      {taskEditor && (
        <div className="modal-backdrop" role="presentation">
          <section className="task-drawer" role="dialog" aria-modal="true" aria-label={taskEditor.mode === "create" ? "משימה חדשה" : "עריכת משימה"}>
            <div className="drawer-header">
              <div>
                <p className="eyebrow">{taskEditor.mode === "create" ? "משימה חדשה" : "עריכת משימה"}</p>
                <h2>{taskEditor.mode === "create" ? "פרטי המשימה" : taskEditor.taskId}</h2>
              </div>
              <button className="icon-button" onClick={closeTaskEditor} aria-label="סגירת חלונית משימה">×</button>
            </div>

            <form className="task-editor-form" onSubmit={saveTaskEditor}>
              <label>
                <span>סוג</span>
                <select value={taskEditor.draft.prefix} onChange={(event) => {
                  const nextPrefix = event.target.value as TaskPrefix;
                  updateTaskDraft({ prefix: nextPrefix, category: topicOptions[nextPrefix][0] ?? (nextPrefix === "W" ? "עבודה" : "אישי") });
                }} disabled={taskEditor.mode === "edit"} aria-label="סוג משימה">
                  <option value="P">אישי</option>
                  <option value="W">עבודה</option>
                </select>
              </label>
              <label>
                <span>שם משימה</span>
                <input value={taskEditor.draft.title} onChange={(event) => updateTaskDraft({ title: event.target.value })} placeholder="מה צריך לעשות?" autoFocus />
              </label>
              <label>
                <span>נושא</span>
                <select value={taskEditor.draft.category} onChange={(event) => updateTaskDraft({ category: event.target.value })}>
                  {topicOptions[taskEditor.draft.prefix].map((topic) => <option value={topic} key={topic}>{topic}</option>)}
                </select>
              </label>
              <label>
                <span>פעולה</span>
                <select value={taskEditor.draft.actionType} onChange={(event) => updateTaskDraft({ actionType: event.target.value })}>
                  <option value="">ללא פעולה</option>
                  {actionOptions.map((action) => <option value={action} key={action}>{action}</option>)}
                </select>
              </label>
              <label>
                <span>סטטוס</span>
                <select value={taskEditor.draft.status} onChange={(event) => updateTaskDraft({ status: event.target.value as TaskStatus })}>
                  {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                <span>עדיפות</span>
                <select value={taskEditor.draft.priority} onChange={(event) => updateTaskDraft({ priority: event.target.value as TaskPriority })}>
                  {Object.entries(priorityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                <span>תאריך יעד</span>
                <input type="date" value={taskEditor.draft.dueDate} onChange={(event) => updateTaskDraft({ dueDate: event.target.value })} />
              </label>
              <label className="notes-field">
                <span>הערות</span>
                <textarea value={taskEditor.draft.notes} onChange={(event) => updateTaskDraft({ notes: event.target.value })} rows={5} />
              </label>
              {taskEditor.mode === "create" && (
                <p className="editor-help">המספר ייווצר אוטומטית לפי הרצף הקיים ולא ניתן לבחור אותו ידנית.</p>
              )}
              {taskEditorError && <p className="editor-error">{taskEditorError}</p>}
              <div className="drawer-actions">
                <button type="submit">{taskEditor.mode === "create" ? "יצירת משימה" : "שמירת שינויים"}</button>
                <button type="button" className="secondary-action" onClick={closeTaskEditor}>ביטול</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}
