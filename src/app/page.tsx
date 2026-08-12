"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent, Dispatch, FormEvent, SetStateAction } from "react";
import type { User } from "@supabase/supabase-js";
import type { AssistantMessage, AssistantProposedAction, AssistantThread } from "@/lib/assistant";
import { canonicalTaskId, initialTasks, Task, TaskPrefix, TaskPriority, TaskStatus, TaskSubtask, TaskSubtaskStatus } from "@/lib/tasks";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { addAssistantMessage, fetchAssistantMessages, fetchDeletedAssistantThreads, getOrCreateAssistantThread, restoreAssistantThread, softDeleteAssistantHistory, updateAssistantMessageActionStatus } from "@/lib/supabaseAssistant";
import { fetchUserDevices, registerCurrentDevice, type UserDevice } from "@/lib/supabaseDevices";
import { countCloudTasks, fetchCloudTasks, saveCloudTasks } from "@/lib/supabaseTasks";
import { fetchCloudTaxonomy, replaceCloudTaxonomy } from "@/lib/supabaseTaxonomy";
import { fetchUserSettings, saveUserSettings } from "@/lib/supabaseUserSettings";

const STORAGE_KEY = "asaf-task-tracker-v1";
const TAXONOMY_STORAGE_KEY = "asaf-task-tracker-taxonomy-v1";
const NOTIFICATION_PREFERENCES_STORAGE_KEY = "asaf-task-tracker-notification-preferences-v1";
const ANALYTICS_PREFERENCES_STORAGE_KEY = "asaf-task-tracker-analytics-preferences-v1";
const USER_SETTINGS_STORAGE_KEY = "asaf-task-tracker-user-settings-v1";
const THEME_STORAGE_KEY = "asaf-task-tracker-theme-v1";
const FOCUSED_TASKS_STORAGE_KEY = "asaf-task-tracker-focused-tasks-v1";
const DEFAULT_STUCK_THRESHOLD_DAYS = 21;

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

const subtaskStatusLabels: Record<TaskSubtaskStatus, string> = {
  open: "טרם בוצע",
  done: "בוצע",
  cancelled: "בוטל",
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
  key?: string;
  label: string;
  value: number;
};

type AnalyticsInsight = {
  id: string;
  title: string;
  body: string;
  tone: "danger" | "warn" | "good" | "neutral";
  priority?: number;
  actionLabel?: string;
  action?: {
    statusFilter?: TaskFilter;
    prefixFilter?: TaskPrefix | "all";
    topicFilter?: string;
    actionFilter?: string;
    query?: string;
  };
};

type AppNotification = {
  id: string;
  title: string;
  body: string;
  tone: "danger" | "warn" | "neutral";
  actionLabel: string;
  action: {
    statusFilter: TaskFilter;
  };
};

type ImportSummary = {
  added: number;
  updated: number;
  skipped: number;
};

type TaskFilter = TaskStatus | "active" | "all" | "overdue" | "today" | "week" | "no_due" | "high" | "subtasks_open" | "focused";
type AnalyticsRange = "week" | "month" | "all";
type MainView = "tasks" | "stats" | "kanban";
type TaxonomyMode = "topics" | "actions";
type SettingsTab = "appearance" | "taxonomy" | "notifications" | "sync";
type AppTheme = "light" | "dark";
type NotificationPreferenceKey = "overdue" | "openSubtasks" | "noWeeklyClosures" | "waiting" | "dueSoon";
type EditingTaxonomyItem =
  | { type: "topic"; prefix: TaskPrefix; name: string; value: string }
  | { type: "action"; name: string; value: string }
  | null;

type TaskTaxonomy = {
  topics: Record<TaskPrefix, string[]>;
  actions: string[];
};

type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;

const defaultNotificationPreferences: NotificationPreferences = {
  overdue: true,
  openSubtasks: true,
  noWeeklyClosures: true,
  waiting: false,
  dueSoon: false,
};

const freeTextInputProps = {
  dir: "auto" as const,
  inputMode: "text" as const,
  autoCapitalize: "sentences",
  autoCorrect: "on",
  spellCheck: true,
};

function taskFilterLabel(filter: TaskFilter) {
  const labels: Record<TaskFilter, string> = {
    ...statusLabels,
    active: "פעילות",
    all: "הכול",
    overdue: "באיחור",
    today: "להיום",
    week: "השבוע",
    no_due: "בלי יעד",
    high: "עדיפות גבוהה",
    subtasks_open: "צעדי טיפול פתוחים",
    focused: "במיקוד",
  };

  return labels[filter];
}

function LoadingSkeleton() {
  return (
    <section className="loading-skeleton" aria-label="טוען את האפליקציה" aria-live="polite">
      <div className="panel skeleton-hero">
        <span className="skeleton-line skeleton-short" />
        <span className="skeleton-line skeleton-title" />
        <span className="skeleton-line skeleton-medium" />
      </div>
      <div className="skeleton-stats" aria-hidden="true">
        <span className="skeleton-card" />
        <span className="skeleton-card" />
        <span className="skeleton-card" />
      </div>
      <div className="panel skeleton-panel" aria-hidden="true">
        <span className="skeleton-line skeleton-medium" />
        <span className="skeleton-line" />
        <span className="skeleton-line" />
        <span className="skeleton-button" />
      </div>
    </section>
  );
}

type TaskDraft = {
  prefix: TaskPrefix;
  title: string;
  category: string;
  actionType: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
  notes: string;
  subtasks: TaskSubtask[];
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

const nowIso = () => new Date().toISOString();

const addDaysIso = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
};

const dateFromIso = (value: string) => new Date(`${value}T00:00:00`);

const toLocalIso = (date: Date) => {
  const localDate = new Date(date);
  localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
  return localDate.toISOString().slice(0, 10);
};

const addDaysToIso = (value: string, days: number) => {
  const date = dateFromIso(value);
  date.setDate(date.getDate() + days);
  return toLocalIso(date);
};

function formatDate(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("he-IL").format(new Date(`${value}T00:00:00`));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric" }).format(dateFromIso(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("he-IL", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatStatusTimestamp(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("he-IL", {
    day: "numeric",
    month: "numeric",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value.includes("T") ? value : `${value}T00:00:00`));
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

function isTaskSubtaskStatus(value: unknown): value is TaskSubtaskStatus {
  return typeof value === "string" && Object.keys(subtaskStatusLabels).includes(value);
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && Object.keys(priorityLabels).includes(value);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeImportedSubtasks(value: unknown, parentId: string): TaskSubtask[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const subtask = item as Record<string, unknown>;
      const number = Number(subtask.number);
      const id = typeof subtask.id === "string" && subtask.id.trim()
        ? subtask.id.trim()
        : Number.isInteger(number) && number > 0
          ? `${parentId}.${number}`
          : "";
      if (!id.startsWith(`${parentId}.`) || !Number.isInteger(number) || number <= 0) return null;
      if (typeof subtask.title !== "string" || !subtask.title.trim()) return null;
      if (!isTaskSubtaskStatus(subtask.status)) return null;
      const normalized: TaskSubtask = {
        id,
        number,
        title: subtask.title.trim(),
        status: subtask.status,
      };

      const actionType = optionalString(subtask.actionType);
      const createdAt = optionalString(subtask.createdAt);
      const statusChangedAt = optionalString(subtask.statusChangedAt);
      if (actionType) normalized.actionType = actionType;
      if (createdAt) normalized.createdAt = createdAt;
      if (statusChangedAt) normalized.statusChangedAt = statusChangedAt;
      return normalized;
    })
    .filter((subtask): subtask is TaskSubtask => Boolean(subtask))
    .sort((a, b) => a.number - b.number);
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
    statusChangedAt: optionalString(task.statusChangedAt),
    subtasks: normalizeImportedSubtasks(task.subtasks, id),
    focused: task.focused === true,
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
  const merged = new Map<string, Task>();

  tasks.forEach((task) => {
    const existing = merged.get(task.id);
    const focused = existing?.focused === true || task.focused === true
      ? true
      : task.focused ?? existing?.focused;

    merged.set(task.id, {
      ...existing,
      ...task,
      focused,
    });
  });

  return Array.from(merged.values())
    .sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || a.prefix.localeCompare(b.prefix) || a.number - b.number);
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
    subtasks: [],
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
    subtasks: [...(task.subtasks ?? [])].sort((a, b) => a.number - b.number),
  };
}

function nextSubtaskNumber(subtasks: TaskSubtask[]) {
  return Math.max(0, ...subtasks.map((subtask) => subtask.number)) + 1;
}

function createSubtaskId(taskId: string, number: number) {
  return `${taskId}.${number}`;
}

function subtaskProgress(subtasks: TaskSubtask[] = []) {
  const activeSubtasks = subtasks.filter((subtask) => subtask.status !== "cancelled");
  const done = activeSubtasks.filter((subtask) => subtask.status === "done").length;
  return {
    done,
    open: activeSubtasks.length - done,
    total: activeSubtasks.length,
    cancelled: subtasks.length - activeSubtasks.length,
  };
}

function subtaskProgressLabel(subtasks: TaskSubtask[] = []) {
  const progress = subtaskProgress(subtasks);
  if (progress.total === 0 && progress.cancelled === 0) return "";
  if (progress.total === 0) return "כל צעדי הטיפול בוטלו";
  if (progress.open === 0) return "כל הצעדים בוצעו";
  return `${progress.open} צעדים פתוחים`;
}

function normalizeDraftSubtasks(subtasks: TaskSubtask[], parentId: string) {
  const usedNumbers = new Set<number>();

  return subtasks
    .filter((subtask) => subtask.title.trim() || subtask.status === "open")
    .map((subtask) => {
      let number = subtask.number;
      if (!Number.isInteger(number) || number <= 0 || usedNumbers.has(number)) {
        number = Math.max(0, ...usedNumbers) + 1;
      }
      usedNumbers.add(number);

      return {
        ...subtask,
        id: createSubtaskId(parentId, number),
        number,
        title: subtask.title.trim(),
        actionType: subtask.actionType?.trim() || undefined,
        createdAt: subtask.createdAt ?? nowIso(),
        statusChangedAt: subtask.statusChangedAt ?? subtask.createdAt ?? nowIso(),
      };
    })
    .sort((a, b) => a.number - b.number);
}

function taskClosureDate(task: Task) {
  return task.statusChangedAt?.slice(0, 10) ?? task.completedAt;
}

function taskStatusTimestamp(task: Task) {
  return task.statusChangedAt ?? (task.status === "done" ? task.completedAt : undefined) ?? task.createdAt;
}

function taskStatusTimestampLabel(task: Task) {
  const timestamp = taskStatusTimestamp(task);
  return timestamp ? `סטטוס ${statusLabels[task.status]} ${formatStatusTimestamp(timestamp)}` : "";
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

function userFocusedTasksStorageKey(userId: string) {
  return `${FOCUSED_TASKS_STORAGE_KEY}:${userId}`;
}

function readLocalFocusedTaskIds(userId: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(userFocusedTasksStorageKey(userId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set<string>();
  }
}

function writeLocalFocusedTaskIds(userId: string, tasks: Task[]) {
  const focusedIds = tasks.filter((task) => task.focused).map((task) => task.id);
  window.localStorage.setItem(userFocusedTasksStorageKey(userId), JSON.stringify(focusedIds));
}

function applyLocalFocusedTasks(tasks: Task[], userId: string) {
  const focusedIds = readLocalFocusedTaskIds(userId);
  if (focusedIds.size === 0) return tasks;
  return tasks.map((task) => focusedIds.has(task.id) ? { ...task, focused: true } : task);
}

function hasLocalFocusedTaskOverrides(tasks: Task[], userId: string) {
  const focusedIds = readLocalFocusedTaskIds(userId);
  if (focusedIds.size === 0) return false;
  return tasks.some((task) => focusedIds.has(task.id) && !task.focused);
}

function parseStoredTasks(raw: string | null, fallbackTasks: Task[]) {
  if (!raw) return fallbackTasks;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const imported = getImportTasks(parsed).map(normalizeImportedTask);
    if (imported.length === 0 && Array.isArray(parsed)) return [];
    if (imported.some((task) => !task)) return fallbackTasks;
    return normalizeTasksForStorage(imported as Task[]);
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
  const safeTasks = normalizeTasksForStorage(nextTasks);
  const raw = JSON.stringify(safeTasks);
  cachedTasksRaw = raw;
  cachedTasks = safeTasks;
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
    const storedTaxonomy = {
      topics: {
        P: uniqueSorted(parsed.topics?.P ?? []),
        W: uniqueSorted(parsed.topics?.W ?? []),
      },
      actions: uniqueSorted(parsed.actions ?? []),
    };
    return isEmptyTaxonomy(storedTaxonomy) ? defaultTaxonomy : storedTaxonomy;
  } catch {
    return defaultTaxonomy;
  }
}

function parseStoredNotificationPreferences(raw: string | null): NotificationPreferences {
  if (!raw) return defaultNotificationPreferences;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<NotificationPreferenceKey, unknown>>;
    return {
      overdue: typeof parsed.overdue === "boolean" ? parsed.overdue : defaultNotificationPreferences.overdue,
      openSubtasks: typeof parsed.openSubtasks === "boolean" ? parsed.openSubtasks : defaultNotificationPreferences.openSubtasks,
      noWeeklyClosures: typeof parsed.noWeeklyClosures === "boolean" ? parsed.noWeeklyClosures : defaultNotificationPreferences.noWeeklyClosures,
      waiting: typeof parsed.waiting === "boolean" ? parsed.waiting : defaultNotificationPreferences.waiting,
      dueSoon: typeof parsed.dueSoon === "boolean" ? parsed.dueSoon : defaultNotificationPreferences.dueSoon,
    };
  } catch {
    return defaultNotificationPreferences;
  }
}

function clampStuckThresholdDays(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_STUCK_THRESHOLD_DAYS;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function parseStoredStuckThresholdDays(raw: string | null) {
  if (!raw) return DEFAULT_STUCK_THRESHOLD_DAYS;
  try {
    const parsed = JSON.parse(raw) as Partial<{ stuckThresholdDays: unknown }>;
    if (typeof parsed.stuckThresholdDays === "number") return clampStuckThresholdDays(parsed.stuckThresholdDays);
  } catch {
    const numericValue = Number(raw);
    if (Number.isFinite(numericValue)) return clampStuckThresholdDays(numericValue);
  }
  return DEFAULT_STUCK_THRESHOLD_DAYS;
}

function replaceValue(values: string[], oldValue: string, newValue: string) {
  return uniqueSorted(values.map((value) => value === oldValue ? newValue : value));
}

function isEmptyTaxonomy(taxonomy: TaskTaxonomy) {
  return taxonomy.topics.P.length === 0 && taxonomy.topics.W.length === 0 && taxonomy.actions.length === 0;
}

function parseStoredTheme(value: string | null): AppTheme {
  return value === "dark" ? "dark" : "light";
}

function userSettingsStorageKey(userId: string) {
  return `${USER_SETTINGS_STORAGE_KEY}:${userId}`;
}

function displayNameFromUser(user: User | null) {
  if (!user) return "";
  const metadata = user.user_metadata as Record<string, unknown>;
  const metadataName = [metadata.full_name, metadata.name, metadata.user_name]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof metadataName === "string") return metadataName.trim();
  return user.email?.split("@")[0]?.trim() ?? "";
}

function normalizeDisplayName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function hasDoneSubtasks(subtasks: TaskSubtask[] = []) {
  return subtasks.some((subtask) => subtask.status === "done");
}

function effectiveTaskStatus(status: TaskStatus, subtasks: TaskSubtask[] = []) {
  return status === "open" && hasDoneSubtasks(subtasks) ? "in_progress" : status;
}

function reconcileTaskStatus(task: Task) {
  const status = effectiveTaskStatus(task.status, task.subtasks);
  return status === task.status ? task : { ...task, status, statusChangedAt: nowIso() };
}

function normalizeTaskForStorage(task: Task) {
  const subtasks = normalizeDraftSubtasks(task.subtasks ?? [], task.id);
  const normalizedTask = {
    ...task,
    title: task.title.trim(),
    category: task.category.trim(),
    actionType: task.actionType?.trim() || undefined,
    notes: task.notes?.trim() || undefined,
    dueDate: task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) ? task.dueDate : undefined,
    createdAt: task.createdAt,
    subtasks,
  };
  return reconcileTaskStatus(normalizedTask);
}

function normalizeTasksForStorage(tasks: Task[]) {
  return mergeUniqueTasks(tasks.map(normalizeTaskForStorage));
}

function sortTasks(tasks: Task[]) {
  return [...tasks].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || a.prefix.localeCompare(b.prefix) || a.number - b.number);
}

export default function Home() {
  const [tasks, setTasks] = usePersistentTasks();
  const [query, setQuery] = useState("");
  const [quickAddTitle, setQuickAddTitle] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskFilter>("active");
  const [prefixFilter, setPrefixFilter] = useState<"all" | "P" | "W">("all");
  const [topicFilter, setTopicFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [activeView, setActiveView] = useState<MainView>("tasks");
  const [analyticsRange, setAnalyticsRange] = useState<AnalyticsRange>("week");
  const [taxonomyMode, setTaxonomyMode] = useState<TaxonomyMode>("topics");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("sync");
  const [theme, setTheme] = useState<AppTheme>("light");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [showClosedKanbanTasks, setShowClosedKanbanTasks] = useState(false);
  const [taxonomy, setTaxonomy] = useState<TaskTaxonomy>(defaultTaxonomy);
  const [taxonomyLoaded, setTaxonomyLoaded] = useState(false);
  const [taxonomyCloudReady, setTaxonomyCloudReady] = useState(false);
  const [taxonomyStatus, setTaxonomyStatus] = useState("נושאים ופעולות נשמרים מקומית עד להתחברות לענן.");
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>(defaultNotificationPreferences);
  const [notificationPreferencesLoaded, setNotificationPreferencesLoaded] = useState(false);
  const [stuckThresholdDays, setStuckThresholdDays] = useState(DEFAULT_STUCK_THRESHOLD_DAYS);
  const [analyticsPreferencesLoaded, setAnalyticsPreferencesLoaded] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [userSettingsStatus, setUserSettingsStatus] = useState("");
  const [newTopicPrefix, setNewTopicPrefix] = useState<TaskPrefix>("P");
  const [newTopicName, setNewTopicName] = useState("");
  const [newActionName, setNewActionName] = useState("");
  const [editingTaxonomyItem, setEditingTaxonomyItem] = useState<EditingTaxonomyItem>(null);
  const [importMessage, setImportMessage] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authIsSending, setAuthIsSending] = useState(false);
  const [authChecked, setAuthChecked] = useState(!supabase);
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
  const [expandedSubtaskTaskIds, setExpandedSubtaskTaskIds] = useState<Set<string>>(() => new Set());
  const [inlineSubtaskDrafts, setInlineSubtaskDrafts] = useState<Record<string, string>>({});
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantStatus, setAssistantStatus] = useState("הצ׳ט ייטען אחרי התחברות לענן.");
  const [assistantIsSending, setAssistantIsSending] = useState(false);
  const [deletedAssistantThreads, setDeletedAssistantThreads] = useState<AssistantThread[]>([]);
  const [assistantRestoreStatus, setAssistantRestoreStatus] = useState("");
  const assistantMessagesRef = useRef<HTMLDivElement | null>(null);
  const [cloudStatus, setCloudStatus] = useState(
    isSupabaseConfigured ? "בודק חיבור ל-Supabase..." : "Supabase עדיין לא מוגדר. עובדים במצב מקומי."
  );

  useEffect(() => {
    if (activeView !== "kanban") return;

    const mobileKanbanQuery = window.matchMedia("(max-width: 700px)");
    const switchToTasksOnMobile = () => {
      if (mobileKanbanQuery.matches) {
        setActiveView("tasks");
      }
    };

    switchToTasksOnMobile();
    mobileKanbanQuery.addEventListener("change", switchToTasksOnMobile);

    return () => {
      mobileKanbanQuery.removeEventListener("change", switchToTasksOnMobile);
    };
  }, [activeView]);

  const mergeCloudTasksIntoLocal = useCallback((cloudTasks: Task[]) => {
    const current = getTasksSnapshot();
    const mergedTasks = mergeUniqueTasks([...current, ...cloudTasks]);
    const merged = cloudUser ? applyLocalFocusedTasks(mergedTasks, cloudUser.id) : mergedTasks;
    if (JSON.stringify(merged) !== JSON.stringify(current)) setTasks(merged);
  }, [cloudUser, setTasks]);

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
    const timeoutId = window.setTimeout(() => {
      setNotificationPreferences(parseStoredNotificationPreferences(window.localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY)));
      setNotificationPreferencesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!notificationPreferencesLoaded) return;
    window.localStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify(notificationPreferences));
  }, [notificationPreferences, notificationPreferencesLoaded]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setStuckThresholdDays(parseStoredStuckThresholdDays(window.localStorage.getItem(ANALYTICS_PREFERENCES_STORAGE_KEY)));
      setAnalyticsPreferencesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!analyticsPreferencesLoaded) return;
    window.localStorage.setItem(ANALYTICS_PREFERENCES_STORAGE_KEY, JSON.stringify({ stuckThresholdDays }));
  }, [analyticsPreferencesLoaded, stuckThresholdDays]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setTheme(parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY)));
      setThemeLoaded(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (!themeLoaded) return;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme, themeLoaded]);

  useEffect(() => {
    if (!isAssistantOpen) return;
    const timeoutId = window.setTimeout(() => {
      const messagesElement = assistantMessagesRef.current;
      if (!messagesElement) return;
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [assistantMessages.length, isAssistantOpen]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user ?? null;
      setTaskStorageUser(user?.id ?? null);
      setCloudUser(user);
      setIsCloudReady(!user);
      setCloudStatus(user ? "טוען משימות מהענן..." : "לא מחובר. יש להתחבר כדי לראות את המשימות.");
    }).finally(() => setAuthChecked(true));

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setAuthChecked(true);
      setTaskStorageUser(user?.id ?? null);
      setCloudUser(user);
      setCloudSyncEnabled(false);
      setCloudTaskCount(null);
      setLastCloudPullAt(null);
      setCloudDevices([]);
      setDevicesStatus("");
      setAssistantThreadId(null);
      setAssistantMessages([]);
      setDeletedAssistantThreads([]);
      setAssistantRestoreStatus("");
      setAssistantStatus(user ? "טוען את שיחת ה-AI..." : "הצ׳ט ייטען אחרי התחברות לענן.");
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
        setTaxonomy(isEmptyTaxonomy(cloudTaxonomy) ? defaultTaxonomy : cloudTaxonomy);
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
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (!cloudUser) {
        setDisplayName("");
        setDisplayNameDraft("");
        setUserSettingsStatus("");
        return;
      }

      const fallbackName = displayNameFromUser(cloudUser);
      const storedName = normalizeDisplayName(window.localStorage.getItem(userSettingsStorageKey(cloudUser.id)) ?? "");
      const initialName = storedName || fallbackName;

      setDisplayName(initialName);
      setDisplayNameDraft(initialName);
      setUserSettingsStatus(initialName ? "שם התצוגה נטען." : "אפשר להגדיר שם שיופיע בכותרת.");

      fetchUserSettings(cloudUser)
        .then((settings) => {
          if (cancelled) return;
          const cloudName = normalizeDisplayName(settings.displayName ?? "");
          if (!cloudName) {
            if (storedName) {
              saveUserSettings(cloudUser, { displayName: storedName })
                .then(() => {
                  if (!cancelled) setUserSettingsStatus("שם התצוגה המקומי סונכרן לענן.");
                })
                .catch((error: unknown) => {
                  if (!cancelled) setUserSettingsStatus(`שמירת שם התצוגה לענן נכשלה: ${errorMessage(error)}`);
                });
            }
            return;
          }
          setDisplayName(cloudName);
          setDisplayNameDraft(cloudName);
          window.localStorage.setItem(userSettingsStorageKey(cloudUser.id), cloudName);
          setUserSettingsStatus("שם התצוגה מסונכרן לענן.");
        })
        .catch((error: unknown) => {
          if (!cancelled) setUserSettingsStatus(`לא הצלחתי לטעון את שם התצוגה מהענן: ${errorMessage(error)}`);
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [cloudUser]);

  useEffect(() => {
    if (!cloudUser || !isCloudReady) return;

    let cancelled = false;

    getOrCreateAssistantThread(cloudUser)
      .then(async (thread) => {
        if (cancelled) return;
        setAssistantThreadId(thread.id);
        const messages = await fetchAssistantMessages(thread.id);
        if (cancelled) return;
        setAssistantMessages(messages);
        setAssistantStatus(messages.length > 0 ? "שיחת ה-AI נטענה מהענן." : "אפשר לשאול את העוזר על המשימות שלך.");
        fetchDeletedAssistantThreads(cloudUser)
          .then((threads) => {
            if (!cancelled) {
              setDeletedAssistantThreads(threads);
              setAssistantRestoreStatus(threads.length ? `יש ${threads.length} שיחות שניתן לשחזר.` : "אין שיחות מחוקות לשחזור.");
            }
          })
          .catch((error: unknown) => {
            if (!cancelled) setAssistantRestoreStatus(`שחזור שיחות עדיין לא פעיל: ${errorMessage(error)}`);
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) setAssistantStatus(`הצ׳ט עדיין לא מוכן: ${errorMessage(error)}. יש להריץ את SQL הצ׳ט ב-Supabase.`);
      });

    return () => {
      cancelled = true;
    };
  }, [cloudUser, isCloudReady]);

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
          const mergedTasks = mergeUniqueTasks(cloudTasks);
          const hasFocusedOverrides = hasLocalFocusedTaskOverrides(mergedTasks, cloudUser.id);
          const localFocusedTasks = applyLocalFocusedTasks(mergedTasks, cloudUser.id);
          setTasks(localFocusedTasks);
          setCloudTaskCount(cloudTasks.length);
          setCloudSyncEnabled(true);
          setLastCloudPullAt(new Date().toISOString());
          setCloudStatus(`מחובר לענן. נטענו ${cloudTasks.length} משימות.`);
          if (hasFocusedOverrides) {
            saveCloudTasks(localFocusedTasks, cloudUser)
              .catch((error: unknown) => setCloudStatus(`שמירת המיקוד לענן נכשלה: ${errorMessage(error)}`));
          }
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
    uniqueSorted([
      ...taxonomy.actions,
      ...tasks.flatMap((task) => [
        task.actionType ?? "",
        ...(task.subtasks ?? []).map((subtask) => subtask.actionType ?? ""),
      ]),
    ])
  ), [tasks, taxonomy]);

  const filteredTasks = useMemo(() => {
    const normalized = canonicalTaskId(query);
    const today = todayIso();
    const weekEnd = addDaysIso(6);
    if (normalized) {
      return sortTasks(tasks.filter((task) => task.id === normalized));
    }
    return sortTasks(tasks
      .filter((task) => prefixFilter === "all" || task.prefix === prefixFilter)
      .filter((task) => topicFilter === "all" || task.category === topicFilter)
      .filter((task) => actionFilter === "all" || (task.actionType ?? "") === actionFilter || (task.subtasks ?? []).some((subtask) => subtask.actionType === actionFilter))
      .filter((task) => {
        if (statusFilter === "all") return true;
        if (statusFilter === "active") return !["done", "cancelled"].includes(task.status);
        if (statusFilter === "focused") return Boolean(task.focused) && !["done", "cancelled"].includes(task.status);
        if (statusFilter === "subtasks_open") return !["done", "cancelled"].includes(task.status) && subtaskProgress(task.subtasks).open > 0;
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
      }));
  }, [tasks, query, statusFilter, prefixFilter, topicFilter, actionFilter]);

  const activeFilters = useMemo(() => {
    const filters: { key: string; label: string }[] = [];
    const trimmedQuery = query.trim();

    if (trimmedQuery) filters.push({ key: "query", label: `חיפוש: ${trimmedQuery}` });
    if (statusFilter !== "active") filters.push({ key: "status", label: `סטטוס: ${taskFilterLabel(statusFilter)}` });
    if (prefixFilter !== "all") filters.push({ key: "prefix", label: `סוג: ${prefixFilter === "P" ? "אישי" : "עבודה"}` });
    if (topicFilter !== "all") filters.push({ key: "topic", label: `נושא: ${topicFilter}` });
    if (actionFilter !== "all") filters.push({ key: "action", label: `פעולה: ${actionFilter}` });

    return filters;
  }, [actionFilter, prefixFilter, query, statusFilter, topicFilter]);

  const clearTaskFilters = useCallback(() => {
    setQuery("");
    setStatusFilter("active");
    setPrefixFilter("all");
    setTopicFilter("all");
    setActionFilter("all");
    setActiveView("tasks");
  }, []);

  const openCreateTask = useCallback(() => {
    setTaskEditorError("");
    setTaskEditor({ mode: "create", draft: defaultTaskDraft(prefixFilter === "W" ? "W" : "P") });
  }, [prefixFilter]);

  function quickAddTask(event: FormEvent) {
    event.preventDefault();
    const title = quickAddTitle.trim();
    if (!title) return;

    setTasks((current) => {
      let prefix: TaskPrefix = prefixFilter === "W" ? "W" : "P";
      if (prefixFilter === "all" && topicFilter !== "all") {
        if (topicOptions.W.includes(topicFilter) && !topicOptions.P.includes(topicFilter)) prefix = "W";
        if (topicOptions.P.includes(topicFilter) && !topicOptions.W.includes(topicFilter)) prefix = "P";
      }
      const nextNumber = nextTaskNumber(current, prefix);
      const createdAt = todayIso();
      const statusChangedAt = nowIso();
      return mergeUniqueTasks([...current, {
        id: `${prefix}${nextNumber}`,
        prefix,
        number: nextNumber,
        title,
        category: topicFilter !== "all" ? topicFilter : prefix === "W" ? "עבודה" : "אישי",
        actionType: actionFilter !== "all" ? actionFilter : undefined,
        priority: "normal",
        status: "open",
        notes: undefined,
        dueDate: undefined,
        createdAt,
        statusChangedAt,
        subtasks: [],
      }]);
    });

    setQuickAddTitle("");
    setActiveView("tasks");
    setStatusFilter("active");
  }

  const emptyTaskState = useMemo(() => {
    const hasNarrowingFilters = activeFilters.length > 0;

    if (query.trim()) {
      return {
        title: "לא נמצאו תוצאות לחיפוש",
        body: "לא נמצאה משימה שמתאימה לחיפוש הנוכחי. אפשר לנקות את החיפוש או לנסות מזהה/מילה אחרת.",
        actionLabel: "ניקוי סינון",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "waiting") {
      return {
        title: "אין משימות ממתינות",
        body: "אין כרגע משימות שמחכות לגורם חיצוני. זה סימן טוב להתקדמות.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "overdue") {
      return {
        title: "אין משימות באיחור",
        body: "אין משימות פעילות שעברו את תאריך היעד שלהן.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "subtasks_open") {
      return {
        title: "אין צעדי טיפול פתוחים",
        body: "לא נמצאו משימות פעילות עם צעדי טיפול פתוחים.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "no_due") {
      return {
        title: "אין משימות בלי יעד",
        body: "לכל המשימות הפעילות שמוצגות כרגע יש תאריך יעד.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "high") {
      return {
        title: "אין משימות בעדיפות גבוהה",
        body: "לא נמצאו משימות פעילות שמסומנות בעדיפות גבוהה.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "focused") {
      return {
        title: "אין משימות במיקוד",
        body: "אפשר לסמן כוכב על משימה חשובה כדי להציף אותה בראש הרשימה.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "today" || statusFilter === "week") {
      return {
        title: statusFilter === "today" ? "אין משימות להיום" : "אין משימות לשבוע הקרוב",
        body: "לא נמצאו משימות פעילות בטווח הזמן שנבחר.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (statusFilter === "done" || statusFilter === "cancelled") {
      return {
        title: statusFilter === "done" ? "אין משימות שבוצעו" : "אין משימות שבוטלו",
        body: "לא נמצאו משימות בהיסטוריה עבור הסטטוס הזה.",
        actionLabel: "הצג פעילות",
        action: clearTaskFilters,
      };
    }

    if (hasNarrowingFilters) {
      return {
        title: "אין התאמה לסינון הנוכחי",
        body: "השילוב של הסינונים מצמצם את הרשימה לאפס משימות.",
        actionLabel: "ניקוי סינון",
        action: clearTaskFilters,
      };
    }

    return {
      title: tasks.length === 0 ? "עדיין אין משימות" : "אין משימות פעילות",
      body: tasks.length === 0 ? "אפשר להתחיל ממשימה ראשונה דרך כפתור הפלוס." : "כל המשימות הפעילות טופלו או נסגרו.",
      actionLabel: "הוספת משימה",
      action: openCreateTask,
    };
  }, [activeFilters.length, clearTaskFilters, openCreateTask, query, statusFilter, tasks.length]);

  const counts = useMemo(() => ({
    active: tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length,
    waiting: tasks.filter((t) => t.status === "waiting").length,
    done: tasks.filter((t) => t.status === "done").length,
    openSubtaskTasks: tasks.filter((t) => !["done", "cancelled"].includes(t.status) && subtaskProgress(t.subtasks).open > 0).length,
  }), [tasks]);

  const appNotifications = useMemo(() => {
    const today = todayIso();
    const weekStartIso = addDaysIso(-6);
    const nextWeekIso = addDaysIso(7);
    const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const overdueCount = active.filter((task) => Boolean(task.dueDate && task.dueDate < today)).length;
    const waitingCount = active.filter((task) => task.status === "waiting").length;
    const dueSoonCount = active.filter((task) => Boolean(task.dueDate && task.dueDate >= today && task.dueDate <= nextWeekIso)).length;
    const openSubtasks = active.reduce((sum, task) => sum + subtaskProgress(task.subtasks).open, 0);
    const completedThisWeek = tasks.filter((task) => {
      const closureDate = task.status === "done" ? taskClosureDate(task) : "";
      return Boolean(closureDate && closureDate >= weekStartIso);
    }).length;
    const notifications: AppNotification[] = [];

    if (notificationPreferences.overdue && overdueCount > 0) {
      notifications.push({
        id: "overdue",
        title: `${overdueCount} משימות באיחור`,
        body: "כדאי לעבור עליהן לפני שמוסיפים משימות חדשות.",
        tone: "danger",
        actionLabel: "הצג באיחור",
        action: { statusFilter: "overdue" },
      });
    }

    if (notificationPreferences.openSubtasks && openSubtasks > 0) {
      notifications.push({
        id: "open-subtasks",
        title: `${openSubtasks} צעדי טיפול פתוחים`,
        body: "יש התקדמות שאפשר לייצר גם בלי לסגור משימה שלמה.",
        tone: openSubtasks >= 8 ? "warn" : "neutral",
        actionLabel: "הצג צעדים",
        action: { statusFilter: "subtasks_open" },
      });
    }

    if (notificationPreferences.noWeeklyClosures && active.length > 0 && completedThisWeek === 0) {
      notifications.push({
        id: "no-weekly-closures",
        title: "אין סגירות השבוע",
        body: "משימה קטנה אחת או צעד טיפול אחד יכולים להחזיר קצב.",
        tone: "warn",
        actionLabel: "הצג פעילות",
        action: { statusFilter: "active" },
      });
    }

    if (notificationPreferences.waiting && waitingCount > 0) {
      notifications.push({
        id: "waiting",
        title: `${waitingCount} משימות ממתינות`,
        body: "שווה לבדוק מי צריך להחזיר תשובה או מה חסום.",
        tone: "warn",
        actionLabel: "הצג ממתינות",
        action: { statusFilter: "waiting" },
      });
    }

    if (notificationPreferences.dueSoon && dueSoonCount > 0) {
      notifications.push({
        id: "due-soon",
        title: `${dueSoonCount} משימות לשבוע הקרוב`,
        body: "כדאי לוודא שהעדיפות והסטטוס עדיין נכונים.",
        tone: "neutral",
        actionLabel: "הצג השבוע",
        action: { statusFilter: "week" },
      });
    }

    return notifications;
  }, [notificationPreferences, tasks]);

  const statistics = useMemo(() => {
    const today = todayIso();
    const monthStartIso = `${today.slice(0, 7)}-01`;
    const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const done = tasks.filter((task) => task.status === "done");
    const completedWithDate = done.filter((task) => taskClosureDate(task));

    return {
      total: tasks.length,
      active: active.length,
      done: done.length,
      overdue: active.filter((task) => Boolean(task.dueDate && task.dueDate < today)).length,
      withoutDueDate: active.filter((task) => !task.dueDate).length,
      completedThisMonth: completedWithDate.filter((task) => {
        const closureDate = taskClosureDate(task);
        return closureDate && closureDate >= monthStartIso;
      }).length,
      byStatus: Object.entries(statusLabels).map(([status, label]) => ({
        label,
        value: tasks.filter((task) => task.status === status).length,
      })),
    };
  }, [tasks]);

  const analytics = useMemo(() => {
    const today = todayIso();
    const weekStartIso = addDaysIso(-6);
    const previousWeekStartIso = addDaysIso(-13);
    const tomorrowIso = addDaysIso(1);
    const nextWeekIso = addDaysIso(7);
    const last30StartIso = addDaysIso(-29);
    const stuckThresholdIso = addDaysIso(-stuckThresholdDays);
    const rangeStartIso = analyticsRange === "week" ? weekStartIso : analyticsRange === "month" ? last30StartIso : "";
    const active = tasks.filter((task) => !["done", "cancelled"].includes(task.status));
    const done = tasks.filter((task) => task.status === "done");
    const completedWithDate = done.filter((task) => taskClosureDate(task));
    const completedInRange = completedWithDate.filter((task) => {
      const closureDate = taskClosureDate(task);
      return !rangeStartIso || Boolean(closureDate && closureDate >= rangeStartIso);
    });
    const completedInRangeCount = analyticsRange === "all" ? done.length : completedInRange.length;
    const completedLast7 = completedWithDate.filter((task) => {
      const closureDate = taskClosureDate(task);
      return closureDate && closureDate >= weekStartIso;
    }).length;
    const completedPrevious7 = completedWithDate.filter((task) => {
      const closureDate = taskClosureDate(task);
      return closureDate && closureDate >= previousWeekStartIso && closureDate < weekStartIso;
    }).length;
    const completedLast30 = completedWithDate.filter((task) => {
      const closureDate = taskClosureDate(task);
      return closureDate && closureDate >= addDaysIso(-29);
    }).length;
    const overdue = active.filter((task) => Boolean(task.dueDate && task.dueDate < today));
    const dueSoon = active.filter((task) => Boolean(task.dueDate && task.dueDate >= tomorrowIso && task.dueDate <= nextWeekIso));
    const waiting = active.filter((task) => task.status === "waiting");
    const withoutDueDate = active.filter((task) => !task.dueDate);
    const highPriority = active.filter((task) => task.priority === "high");
    const withOpenSubtasks = active.filter((task) => subtaskProgress(task.subtasks).open > 0);
    const openSubtasks = withOpenSubtasks.reduce((sum, task) => sum + subtaskProgress(task.subtasks).open, 0);
    const allSubtaskItems = tasks.flatMap((task) => (task.subtasks ?? []).map((subtask) => ({ task, subtask })));
    const countedSubtaskItems = allSubtaskItems.filter(({ subtask }) => subtask.status !== "cancelled");
    const doneSubtaskItems = allSubtaskItems.filter(({ subtask }) => subtask.status === "done");
    const completedSubtasksInRange = doneSubtaskItems.filter(({ subtask }) => {
      const statusDate = subtask.statusChangedAt?.slice(0, 10);
      return !rangeStartIso || Boolean(statusDate && statusDate >= rangeStartIso);
    });
    const completedSubtasksInRangeCount = analyticsRange === "all" ? doneSubtaskItems.length : completedSubtasksInRange.length;
    const subtaskCompletionRate = countedSubtaskItems.length > 0
      ? Math.round((doneSubtaskItems.length / countedSubtaskItems.length) * 100)
      : 0;
    const openSubtaskItems = allSubtaskItems.filter(({ task, subtask }) => (
      !["done", "cancelled"].includes(task.status) && subtask.status === "open"
    ));
    const subtasksByAction = Array.from(new Set(openSubtaskItems.map(({ subtask }) => subtask.actionType?.trim() || "ללא פעולה")))
      .map((label) => ({
        label,
        value: openSubtaskItems.filter(({ subtask }) => (subtask.actionType?.trim() || "ללא פעולה") === label).length,
      }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const tasksByOpenSubtasks = withOpenSubtasks
      .map((task) => ({ task, value: subtaskProgress(task.subtasks).open }))
      .sort((a, b) => b.value - a.value || a.task.number - b.task.number);
    const staleInProgress = active.filter((task) => {
      const statusDate = taskStatusTimestamp(task)?.slice(0, 10);
      return task.status === "in_progress" && Boolean(statusDate && statusDate < stuckThresholdIso);
    });
    const activeWithAllSubtasksDone = active.filter((task) => {
      const progress = subtaskProgress(task.subtasks);
      return progress.total > 0 && progress.open === 0;
    });
    const doneWithOpenSubtasks = done.filter((task) => subtaskProgress(task.subtasks).open > 0);
    const inProgressWithoutSubtasks = active.filter((task) => (
      task.status === "in_progress" && subtaskProgress(task.subtasks).total === 0
    ));
    const activeByPrefix = {
      P: active.filter((task) => task.prefix === "P").length,
      W: active.filter((task) => task.prefix === "W").length,
    };
    const attentionMap = new Map<string, Task>();
    const addAttention = (source: Task[]) => source.forEach((task) => {
      if (!attentionMap.has(task.id)) attentionMap.set(task.id, task);
    });

    addAttention([...overdue].sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.number - b.number));
    addAttention([...highPriority].sort((a, b) => a.number - b.number));
    addAttention([...withOpenSubtasks].sort((a, b) => subtaskProgress(b.subtasks).open - subtaskProgress(a.subtasks).open || a.number - b.number));
    addAttention([...waiting].sort((a, b) => a.number - b.number));
    addAttention([...withoutDueDate].sort((a, b) => a.number - b.number));

    const activeCategories = Array.from(new Set(active.map((task) => task.category))).map((category) => ({
      label: category,
      value: active.filter((task) => task.category === category).length,
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const topCategory = activeCategories[0];
    const activeActions = Array.from(new Set(active.map((task) => task.actionType?.trim() || "ללא פעולה"))).map((action) => ({
      label: action,
      value: active.filter((task) => (task.actionType?.trim() || "ללא פעולה") === action).length,
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const topAction = activeActions[0];
    const highWithoutDueDate = withoutDueDate.filter((task) => task.priority === "high" || task.priority === "important");
    const stuckTasks = active
      .filter((task) => {
        const statusDate = taskStatusTimestamp(task)?.slice(0, 10);
        return Boolean(statusDate && statusDate < stuckThresholdIso);
      })
      .sort((a, b) => (taskStatusTimestamp(a) ?? "").localeCompare(taskStatusTimestamp(b) ?? "") || a.number - b.number);
    const insights: AnalyticsInsight[] = [];
    const addInsight = (insight: AnalyticsInsight) => insights.push(insight);

    if (openSubtasks > 0) {
      addInsight({
        id: "open-subtasks",
        title: `${openSubtasks} צעדי טיפול פתוחים`,
        body: `${withOpenSubtasks.length} משימות כבר פורקו לצעדים. כדאי לסגור צעד קטן אחד כדי לייצר התקדמות גם בלי לסגור משימה שלמה.`,
        tone: openSubtasks >= 8 ? "warn" : "neutral",
        priority: openSubtasks >= 8 ? 89 : 68,
        actionLabel: "הצג צעדים פתוחים",
        action: { statusFilter: "subtasks_open" },
      });
    }

    if (completedSubtasksInRangeCount > 0) {
      addInsight({
        id: "completed-subtasks",
        title: `${completedSubtasksInRangeCount} צעדי טיפול נסגרו`,
        body: `זה סימן להתקדמות בתוך משימות, גם אם המשימה הראשית עדיין לא נסגרה. שיעור השלמת הצעדים הכולל עומד על ${subtaskCompletionRate}%.`,
        tone: "good",
        priority: 73,
        actionLabel: "הצג צעדים פתוחים",
        action: { statusFilter: "subtasks_open" },
      });
    } else if (openSubtasks > 0) {
      addInsight({
        id: "no-subtask-progress",
        title: "אין סגירת צעדי טיפול בטווח",
        body: "יש צעדים פתוחים, אבל לא נסגרו צעדים בטווח שבחרת. כדאי לבחור צעד קטן אחד ולסמן אותו כבוצע.",
        tone: analyticsRange === "week" ? "warn" : "neutral",
        priority: analyticsRange === "week" ? 90 : 63,
        actionLabel: "הצג צעדים פתוחים",
        action: { statusFilter: "subtasks_open" },
      });
    }

    if (tasksByOpenSubtasks[0]?.value >= 4) {
      const topTask = tasksByOpenSubtasks[0];
      addInsight({
        id: "subtask-heavy-task",
        title: `הרבה צעדים פתוחים ב-${topTask.task.id}`,
        body: `במשימה "${topTask.task.title}" יש ${topTask.value} צעדי טיפול פתוחים. זה מקום טוב להתחיל בו כדי לפרק עומס.`,
        tone: "warn",
        priority: 87,
        actionLabel: "פתח משימה",
        action: { query: topTask.task.id, statusFilter: "all" },
      });
    }

    if (subtasksByAction[0]?.value >= 3) {
      const topAction = subtasksByAction[0];
      addInsight({
        id: "subtask-action-load",
        title: `עומס צעדים בפעולה ${topAction.label}`,
        body: `${topAction.value} צעדי טיפול פתוחים משויכים לפעולה הזו. אפשר לרכז טיפול מסוג אחד ולסגור כמה צעדים ברצף.`,
        tone: "neutral",
        priority: topAction.value >= 6 ? 83 : 66,
        actionLabel: topAction.label === "ללא פעולה" ? "הצג צעדים" : "פתח פעולה",
        action: {
          statusFilter: "subtasks_open",
          actionFilter: topAction.label === "ללא פעולה" ? "all" : topAction.label,
        },
      });
    }

    if (overdue.length > 0) {
      addInsight({
        id: "overdue",
        title: `${overdue.length} משימות באיחור`,
        body: "כדאי להתחיל מהן לפני הוספת משימות חדשות, כדי להוריד עומס פתוח.",
        tone: "danger",
        priority: 100,
        actionLabel: "הצג באיחור",
        action: { statusFilter: "overdue" },
      });
    } else if (active.length > 0) {
      addInsight({
        id: "no-overdue",
        title: "אין משימות באיחור",
        body: "מצב טוב. אפשר להתמקד במשימות בעדיפות גבוהה או בממתינות.",
        tone: "good",
        priority: 25,
        actionLabel: highPriority.length > 0 ? "הצג גבוהה" : "הצג פעילות",
        action: { statusFilter: highPriority.length > 0 ? "high" : "active" },
      });
    }

    if (completedLast7 < completedPrevious7 && completedPrevious7 >= 2) {
      addInsight({
        id: "closure-slowdown",
        title: "קצב הסגירה ירד השבוע",
        body: `${completedLast7} סגירות השבוע לעומת ${completedPrevious7} בשבוע הקודם. כדאי לבחור משימה קטנה אחת ולסגור אותה כדי להחזיר תנופה.`,
        tone: "warn",
        priority: 92,
        actionLabel: "הצג פעילות",
        action: { statusFilter: "active" },
      });
    } else if (completedLast7 > completedPrevious7 && completedLast7 > 0) {
      addInsight({
        id: "closure-improved",
        title: "קצב הסגירה השתפר",
        body: `${completedLast7} סגירות השבוע לעומת ${completedPrevious7} בשבוע הקודם. שווה לשמר את הקצב עם עוד משימה קצרה.`,
        tone: "good",
        priority: 55,
        actionLabel: "הצג פעילות",
        action: { statusFilter: "active" },
      });
    }

    if (activeByPrefix.P >= Math.max(6, activeByPrefix.W * 2)) {
      addInsight({
        id: "personal-load",
        title: "עומס גבוה במשימות אישיות",
        body: `${activeByPrefix.P} משימות אישיות פעילות לעומת ${activeByPrefix.W} בעבודה. כדאי לבחור נושא אישי אחד ולצמצם אותו לפני פתיחת עוד משימות.`,
        tone: "warn",
        priority: 86,
        actionLabel: "הצג אישי",
        action: { statusFilter: "active", prefixFilter: "P" },
      });
    } else if (activeByPrefix.W >= Math.max(6, activeByPrefix.P * 2)) {
      addInsight({
        id: "work-load",
        title: "עומס גבוה במשימות עבודה",
        body: `${activeByPrefix.W} משימות עבודה פעילות לעומת ${activeByPrefix.P} אישיות. כדאי למקד פעולה אחת שתשחרר חסימה או תוריד עומס.`,
        tone: "warn",
        priority: 86,
        actionLabel: "הצג עבודה",
        action: { statusFilter: "active", prefixFilter: "W" },
      });
    }

    if (dueSoon.length > 0) {
      addInsight({
        id: "due-soon",
        title: `${dueSoon.length} משימות מתקרבות השבוע`,
        body: "יש משימות עם תאריך יעד קרוב. כדאי לעבור עליהן עכשיו ולוודא שהעדיפות והסטטוס עדיין נכונים.",
        tone: dueSoon.length >= 3 ? "warn" : "neutral",
        priority: dueSoon.length >= 3 ? 84 : 58,
        actionLabel: "הצג השבוע",
        action: { statusFilter: "week" },
      });
    }

    if (topCategory && topCategory.value >= 3) {
      addInsight({
        id: "top-category",
        title: `עומס מרכזי בנושא ${topCategory.label}`,
        body: `${topCategory.value} משימות פעילות מרוכזות שם. זה כנראה המקום שבו מיקוד קצר ייתן הכי הרבה ערך.`,
        tone: "warn",
        priority: topCategory.value >= 6 ? 88 : 70,
        actionLabel: "פתח נושא",
        action: { statusFilter: "active", topicFilter: topCategory.label },
      });
    }

    if (topAction && topAction.value >= 3) {
      addInsight({
        id: "top-action",
        title: `עומס פעולה: ${topAction.label}`,
        body: `${topAction.value} משימות פעילות משויכות לאותה פעולה. זה יכול לעזור לבחור מצב עבודה אחד ולסגור כמה פריטים ברצף.`,
        tone: topAction.value >= 6 ? "warn" : "neutral",
        priority: topAction.value >= 6 ? 85 : 64,
        actionLabel: topAction.label === "ללא פעולה" ? "הצג פעילות" : "פתח פעולה",
        action: {
          statusFilter: "active",
          actionFilter: topAction.label === "ללא פעולה" ? "all" : topAction.label,
        },
      });
    }

    if (highWithoutDueDate.length > 0) {
      addInsight({
        id: "high-without-due-date",
        title: `${highWithoutDueDate.length} משימות חשובות בלי יעד`,
        body: "אלה משימות בעדיפות גבוהה או חשובה שאין להן תאריך יעד. כדאי לתת יעד רק לאלו שבאמת צריכות לזוז בקרוב.",
        tone: "warn",
        priority: highWithoutDueDate.length >= 3 ? 83 : 69,
        actionLabel: "הצג בלי יעד",
        action: { statusFilter: "no_due" },
      });
    }

    if (activeWithAllSubtasksDone.length > 0) {
      addInsight({
        id: "all-subtasks-done",
        title: `${activeWithAllSubtasksDone.length} משימות שכל הצעדים שלהן בוצעו`,
        body: "יש משימות פעילות שכל צעדי הטיפול שלהן כבר סגורים. זה מקום טוב לבדוק אם אפשר לסגור את המשימה הראשית.",
        tone: "good",
        priority: 76,
        actionLabel: "פתח ראשונה",
        action: { query: activeWithAllSubtasksDone[0].id, statusFilter: "all" },
      });
    }

    if (doneWithOpenSubtasks.length > 0) {
      addInsight({
        id: "done-with-open-subtasks",
        title: `${doneWithOpenSubtasks.length} משימות סגורות עם צעדים פתוחים`,
        body: "יש משימות שסומנו כבוצעו אבל נשארו בהן צעדי טיפול פתוחים. כדאי לבדוק אם הצעדים בוצעו, בוטלו או צריכים משימה חדשה.",
        tone: "warn",
        priority: 81,
        actionLabel: "פתח לבדיקה",
        action: { query: doneWithOpenSubtasks[0].id, statusFilter: "all" },
      });
    }

    if (inProgressWithoutSubtasks.length > 0) {
      addInsight({
        id: "in-progress-without-subtasks",
        title: `${inProgressWithoutSubtasks.length} משימות בטיפול בלי צעדי טיפול`,
        body: "משימות בטיפול בלי צעדים מקשות להבין מה ההתקדמות הבאה. כדאי להוסיף צעד טיפול אחד ברור למשימה המרכזית ביותר.",
        tone: "neutral",
        priority: inProgressWithoutSubtasks.length >= 3 ? 71 : 52,
        actionLabel: "פתח ראשונה",
        action: { query: inProgressWithoutSubtasks[0].id, statusFilter: "all" },
      });
    }

    if (withoutDueDate.length > 0) {
      addInsight({
        id: "without-due-date",
        title: `${withoutDueDate.length} משימות בלי תאריך יעד`,
        body: "לא חייבים לתארך הכול, אבל כדאי לתת יעד למשימות שצריכות לזוז השבוע.",
        tone: "neutral",
        priority: withoutDueDate.length >= 8 ? 80 : 45,
        actionLabel: "הצג בלי יעד",
        action: { statusFilter: "no_due" },
      });
    }

    if (waiting.length > 0) {
      addInsight({
        id: "waiting",
        title: `${waiting.length} משימות ממתינות`,
        body: "שווה לבדוק מי הגורם החוסם ולסגור לולאה קצרה במקום לתת לזה להישאר פתוח.",
        tone: "warn",
        priority: waiting.length >= 3 ? 82 : 60,
        actionLabel: "הצג ממתינות",
        action: { statusFilter: "waiting" },
      });
    }

    if (staleInProgress.length > 0) {
      addInsight({
        id: "stale-in-progress",
        title: `${staleInProgress.length} משימות בטיפול שלא זזו`,
        body: `יש משימות שנמצאות בטיפול מעל ${stuckThresholdDays} יום לפי מועד שינוי הסטטוס האחרון. כדאי להחליט אם לקדם, להעביר לממתינה או לסגור.`,
        tone: "warn",
        priority: 78,
        actionLabel: "הצג בטיפול",
        action: { statusFilter: "in_progress" },
      });
    }

    addInsight({
      id: "completion-rate",
      title: done.length > completedLast30
        ? `${completedLast7} השבוע, ${completedLast30} ב-30 יום, ${done.length} היסטוריות`
        : `${completedLast7} נסגרו השבוע, ${completedLast30} ב-30 יום`,
      body: completedLast7 > 0
        ? "יש תנועה קדימה. המדד הזה יעזור לזהות בהמשך אם הקצב יורד או עולה."
        : done.length > 0
          ? "יש משימות שהושלמו בעבר, אבל השבוע לא נסגרה משימה מתוארכת. סגירות חדשות יופיעו במדד השבועי."
          : "השבוע עוד לא נסגרו משימות. אפשר לבחור משימה קטנה אחת ולייצר התקדמות מהירה.",
      tone: completedLast7 > 0 ? "good" : "neutral",
      priority: completedLast7 > 0 ? 50 : 72,
      actionLabel: done.length > 0 ? "הצג הושלמו" : "הצג פעילות",
      action: { statusFilter: done.length > 0 ? "done" : "active" },
    });

    if (stuckTasks.length > 0) {
      addInsight({
        id: "stuck",
        title: "יש משימות שנראות תקועות",
        body: `${stuckTasks.length} משימות פעילות לא שינו סטטוס מעל ${stuckThresholdDays} יום. כדאי לבחור אחת ולהחליט: לקדם, לעדכן יעד, להעביר לממתינה או לסגור.`,
        tone: "danger",
        priority: 95,
        actionLabel: "פתח ראשונה",
        action: { query: stuckTasks[0].id, statusFilter: "all" },
      });
    }

    const completionTrend = (() => {
      if (analyticsRange === "week") {
        return Array.from({ length: 7 }, (_, index) => {
          const date = addDaysIso(index - 6);
          return {
            key: date,
            label: new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "numeric" }).format(dateFromIso(date)),
            value: completedWithDate.filter((task) => taskClosureDate(task) === date).length,
          };
        });
      }

      if (analyticsRange === "month") {
        const rows: StatRow[] = [];
        let weekStart = last30StartIso;

        while (weekStart <= today) {
          const weekEnd = addDaysToIso(weekStart, 6) > today ? today : addDaysToIso(weekStart, 6);
          rows.push({
            key: weekStart,
            label: `${formatShortDate(weekStart)}-${formatShortDate(weekEnd)}`,
            value: completedWithDate.filter((task) => (
              Boolean(taskClosureDate(task) && taskClosureDate(task)! >= weekStart && taskClosureDate(task)! <= weekEnd)
            )).length,
          });
          weekStart = addDaysToIso(weekEnd, 1);
        }

        return rows;
      }

      const datedMonths = completedWithDate
        .map((task) => taskClosureDate(task)?.slice(0, 7))
        .filter((value): value is string => Boolean(value))
        .sort();
      const firstMonth = datedMonths[0] ?? today.slice(0, 7);
      const lastMonth = today.slice(0, 7);
      const rows: StatRow[] = [];
      let monthCursor = `${firstMonth}-01`;
      const lastMonthIso = `${lastMonth}-01`;

      while (monthCursor <= lastMonthIso) {
        const monthKey = monthCursor.slice(0, 7);
        rows.push({
          key: monthKey,
          label: new Intl.DateTimeFormat("he-IL", { month: "short", year: "2-digit" }).format(dateFromIso(monthCursor)),
          value: completedWithDate.filter((task) => taskClosureDate(task)?.startsWith(monthKey)).length,
        });

        const nextMonth = dateFromIso(monthCursor);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        monthCursor = toLocalIso(nextMonth);
      }

      return rows;
    })();

    const createdDate = (task: Task) => task.createdAt?.slice(0, 10);
    const openedLast7 = tasks.filter((task) => {
      const date = createdDate(task);
      return Boolean(date && date >= weekStartIso);
    }).length;
    const openedPrevious7 = tasks.filter((task) => {
      const date = createdDate(task);
      return Boolean(date && date >= previousWeekStartIso && date < weekStartIso);
    }).length;
    const previous30StartIso = addDaysIso(-59);
    const openedLast30 = tasks.filter((task) => {
      const date = createdDate(task);
      return Boolean(date && date >= last30StartIso);
    }).length;
    const openedPrevious30 = tasks.filter((task) => {
      const date = createdDate(task);
      return Boolean(date && date >= previous30StartIso && date < last30StartIso);
    }).length;
    const completedPrevious30 = completedWithDate.filter((task) => {
      const closureDate = taskClosureDate(task);
      return closureDate && closureDate >= previous30StartIso && closureDate < last30StartIso;
    }).length;
    const olderThan30 = active.filter((task) => {
      const date = createdDate(task);
      return Boolean(date && date < last30StartIso);
    }).length;
    const cancelled = tasks.filter((task) => task.status === "cancelled").length;
    const allCompletionRate = tasks.length > 0 ? Math.round((done.length / tasks.length) * 100) : 0;
    const weeklyDirection = completedLast7 > completedPrevious7
      ? `קצב הסגירה עלה: ${completedLast7} השבוע מול ${completedPrevious7} בשבוע הקודם`
      : completedLast7 < completedPrevious7
        ? `קצב הסגירה ירד: ${completedLast7} השבוע מול ${completedPrevious7} בשבוע הקודם`
        : `קצב הסגירה יציב: ${completedLast7} השבוע וגם ${completedPrevious7} בשבוע הקודם`;
    const weeklyOpenedDirection = openedLast7 > openedPrevious7
      ? `נפתחו יותר משימות מהשבוע הקודם: ${openedLast7} מול ${openedPrevious7}`
      : openedLast7 < openedPrevious7
        ? `נפתחו פחות משימות מהשבוע הקודם: ${openedLast7} מול ${openedPrevious7}`
        : `כמות המשימות שנפתחו יציבה: ${openedLast7} השבוע וגם ${openedPrevious7} בשבוע הקודם`;
    const monthlyNet = openedLast30 - completedLast30;
    const previousMonthlyNet = openedPrevious30 - completedPrevious30;
    const monthlyTrend = monthlyNet > previousMonthlyNet
      ? `העומס גדל לעומת התקופה הקודמת: נטו ${monthlyNet > 0 ? "+" : ""}${monthlyNet}`
      : monthlyNet < previousMonthlyNet
        ? `העומס ירד לעומת התקופה הקודמת: נטו ${monthlyNet > 0 ? "+" : ""}${monthlyNet}`
        : `העומס נטו יציב: ${monthlyNet > 0 ? "+" : ""}${monthlyNet}`;
    const summaryTitle = analyticsRange === "week"
      ? "סיכום שבועי"
      : analyticsRange === "month"
        ? "סיכום חודשי"
        : "סיכום כללי";
    const summaryBody = analyticsRange === "week"
      ? "מבט קצר על השבוע הנוכחי: מה נכנס, מה נסגר, והאם יש משהו שמצריך פעולה מיידית."
      : analyticsRange === "month"
        ? "מבט מגמה על 30 הימים האחרונים: האם העומס גדל או קטן, ואיפה הוא מתרכז."
        : "תמונה מבנית של כלל המערכת: מצב המשימות, יחס אישי/עבודה, והיקף ההיסטוריה.";
    const summaryHighlights = analyticsRange === "week"
      ? [
        `${openedLast7} משימות נפתחו השבוע`,
        `${completedLast7} משימות נסגרו השבוע`,
        weeklyDirection,
        weeklyOpenedDirection,
        `${completedSubtasksInRangeCount} צעדי טיפול נסגרו השבוע`,
      ]
      : analyticsRange === "month"
        ? [
          `${openedLast30} משימות נפתחו ב-30 הימים האחרונים`,
          `${completedLast30} משימות נסגרו ב-30 הימים האחרונים`,
          monthlyTrend,
          `${olderThan30} משימות פעילות פתוחות מעל 30 יום`,
          topCategory ? `העומס המרכזי החודש נמצא בנושא ${topCategory.label}` : "אין כרגע נושא עומס מרכזי",
        ]
        : [
          `${tasks.length} משימות בסך הכול, ${done.length} הושלמו ו-${cancelled} בוטלו`,
          `שיעור השלמה כללי: ${allCompletionRate}%`,
          `${activeByPrefix.P} משימות אישיות פעילות מול ${activeByPrefix.W} משימות עבודה פעילות`,
          `${withoutDueDate.length} משימות פעילות בלי תאריך יעד`,
          countedSubtaskItems.length > 0 ? `${subtaskCompletionRate}% השלמה בצעדי טיפול` : "אין עדיין צעדי טיפול למדידה",
        ];
    const summaryAction = overdue.length > 0
      ? { actionLabel: "הצג באיחור", action: { statusFilter: "overdue" as TaskFilter } }
      : openSubtasks > 0
        ? { actionLabel: "הצג צעדים פתוחים", action: { statusFilter: "subtasks_open" as TaskFilter } }
        : dueSoon.length > 0
          ? { actionLabel: "הצג השבוע", action: { statusFilter: "week" as TaskFilter } }
          : { actionLabel: "הצג פעילות", action: { statusFilter: "active" as TaskFilter } };

    const sortedInsights = insights.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const positiveInsight = sortedInsights.find((insight) => insight.tone === "good");
    const actionableInsights = sortedInsights
      .filter((insight) => insight.tone !== "good")
      .slice(0, positiveInsight ? 4 : 5);
    const selectedInsights = positiveInsight
      ? [...actionableInsights, positiveInsight].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      : actionableInsights;

    return {
      periodSummary: {
        title: summaryTitle,
        body: summaryBody,
        highlights: summaryHighlights,
        ...summaryAction,
      },
      completedInRange: completedInRangeCount,
      hasDatedCompletions: completedWithDate.length > 0,
      hasRecentCompletions: completionTrend.some((row) => row.value > 0),
      undatedCompleted: done.length - completedWithDate.length,
      completionTrend,
      waiting: waiting.length,
      openSubtasks,
      withOpenSubtasks: withOpenSubtasks.length,
      completedSubtasksInRange: completedSubtasksInRangeCount,
      totalSubtasks: countedSubtaskItems.length,
      doneSubtasks: doneSubtaskItems.length,
      subtaskCompletionRate,
      subtasksByAction,
      tasksByOpenSubtasks: tasksByOpenSubtasks.slice(0, 5),
      byCategory: activeCategories,
      attention: Array.from(attentionMap.values()).slice(0, 8),
      insights: selectedInsights,
    };
  }, [analyticsRange, stuckThresholdDays, tasks]);

  function maxValue(rows: StatRow[]) {
    return Math.max(1, ...rows.map((row) => row.value));
  }

  function maxTrendValue() {
    return Math.max(1, ...analytics.completionTrend.map((row) => row.value));
  }

  function analyticsRangeLabel() {
    if (analyticsRange === "week") return "7 ימים";
    if (analyticsRange === "month") return "30 ימים";
    return "הכול כולל היסטוריה";
  }

  function completionChartTitle() {
    if (analyticsRange === "week") return "קצב סגירה - 7 ימים אחרונים";
    if (analyticsRange === "month") return "קצב סגירה - 30 ימים לפי שבועות";
    return "קצב סגירה - הכול לפי חודשים";
  }

  function completionChartSubtitle() {
    if (analyticsRange === "week") return "משימות שנסגרו לפי יום";
    if (analyticsRange === "month") return "משימות שנסגרו לפי שבוע";
    return "משימות שנסגרו לפי חודש";
  }

  function completionChartEmptyTitle() {
    if (analyticsRange === "all" && analytics.completedInRange > 0) {
      return `יש ${analytics.completedInRange} משימות שהושלמו בהיסטוריה`;
    }
    if (analyticsRange === "month" && analytics.completedInRange > 0) {
      return `יש ${analytics.completedInRange} סגירות מתוארכות ב-30 הימים האחרונים`;
    }
    if (analyticsRange === "all") return "אין סגירות מתוארכות להצגה";
    if (analyticsRange === "month") return "אין סגירות ב-30 הימים האחרונים";
    return "אין סגירות ב-7 הימים האחרונים";
  }

  function completionChartEmptyBody() {
    if (analyticsRange === "all" && analytics.completedInRange > 0) {
      return "חלק מהמשימות ההיסטוריות הושלמו לפני שהתחלנו לשמור תאריך סגירה, ולכן אי אפשר לשייך אותן לחודש מסוים. סגירות חדשות יופיעו כאן לפי חודש הסגירה.";
    }
    if (analyticsRange === "month" && analytics.completedInRange > 0) {
      return "יש סגירות מתוארכות ב-30 הימים האחרונים, אבל הן לא משויכות לשבוע שמוצג כרגע. סגירות חדשות יופיעו כאן לפי שבוע.";
    }
    if (!analytics.hasDatedCompletions && analytics.undatedCompleted > 0) {
      return `קיימות ${analytics.undatedCompleted} משימות שבוצעו ללא תאריך סגירה היסטורי. משימות שתסמן כבוצעו מעכשיו יופיעו כאן לפי הטווח שבחרת.`;
    }
    return "יש משימות שבוצעו בעבר, אבל אין סגירות מתוארכות בטווח הנבחר. משימה שתסומן כבוצעה תופיע כאן מיד בגרף.";
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
    setActionFilter("all");
    setTopicFilter("all");
    setActiveView("tasks");
  }

  function showTaskList(filter: TaskFilter, options: AnalyticsInsight["action"] = {}) {
    setQuery(options.query ?? "");
    setStatusFilter(filter);
    setPrefixFilter(options.prefixFilter ?? "all");
    setActionFilter(options.actionFilter ?? "all");
    setTopicFilter(options.topicFilter ?? "all");
    setActiveView("tasks");
  }

  function applyInsightAction(insight: AnalyticsInsight) {
    applyAnalyticsAction(insight.action);
  }

  function applyAnalyticsAction(action: AnalyticsInsight["action"]) {
    if (!action) return;
    showTaskList(action.statusFilter ?? "active", action);
  }

  function applyNotificationAction(notification: AppNotification) {
    showTaskList(notification.action.statusFilter);
  }

  function updateNotificationPreference(key: NotificationPreferenceKey, value: boolean) {
    setNotificationPreferences((current) => ({ ...current, [key]: value }));
  }

  function updateStuckThresholdDays(value: string) {
    setStuckThresholdDays(clampStuckThresholdDays(Number(value)));
  }

  async function saveDisplayName(event: FormEvent) {
    event.preventDefault();
    if (!cloudUser) return;
    const nextName = normalizeDisplayName(displayNameDraft);
    setDisplayName(nextName);
    setDisplayNameDraft(nextName);
    window.localStorage.setItem(userSettingsStorageKey(cloudUser.id), nextName);
    setUserSettingsStatus("שומר את שם התצוגה...");

    try {
      await saveUserSettings(cloudUser, { displayName: nextName || undefined });
      setUserSettingsStatus(nextName ? "שם התצוגה נשמר." : "שם התצוגה נוקה.");
    } catch (error) {
      setUserSettingsStatus(`שם התצוגה נשמר במכשיר הזה, אבל לא בענן: ${errorMessage(error)}`);
    }
  }

  function updateStatus(id: string, status: TaskStatus) {
    setTasks((current) => current.map((task) => {
      if (task.id !== id) return task;
      const nextStatus = effectiveTaskStatus(status, task.subtasks);
      const statusChangedAt = task.status === nextStatus ? task.statusChangedAt : nowIso();
      return {
        ...task,
        status: nextStatus,
        completedAt: nextStatus === "done" ? (task.status === "done" ? task.completedAt ?? todayIso() : todayIso()) : undefined,
        statusChangedAt,
      };
    }));
  }

  function toggleTaskFocus(id: string) {
    const nextTasks = getTasksSnapshot().map((task) => (
      task.id === id ? { ...task, focused: !task.focused } : task
    ));
    setTasks(nextTasks);

    if (cloudUser) writeLocalFocusedTaskIds(cloudUser.id, nextTasks);

    if (cloudUser && isCloudReady) {
      saveCloudTasks(nextTasks, cloudUser)
        .then(() => {
          setCloudTaskCount(nextTasks.length);
          setCloudStatus("׳”׳׳©׳™׳׳•׳× ׳׳¡׳•׳ ׳›׳¨׳ ׳•׳× ׳׳¢׳ ׳.");
        })
        .catch((error: unknown) => setCloudStatus(`׳©׳׳™׳¨׳× ׳”׳׳™׳§׳•׳“ ׳׳¢׳ ׳ ׳ ׳›׳©׳׳”: ${errorMessage(error)}`));
    }
  }

  function isOverdue(task: Task) {
    return Boolean(task.dueDate && !["done", "cancelled"].includes(task.status) && task.dueDate < todayIso());
  }

  function openEditTask(task: Task) {
    setTaskEditorError("");
    setTaskEditor({ mode: "edit", taskId: task.id, draft: taskToDraft(task) });
  }

  function toggleTaskSubtasks(taskId: string) {
    setExpandedSubtaskTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }

  function updateTaskSubtask(taskId: string, subtaskNumber: number, updates: Partial<TaskSubtask>) {
    setTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task;
      return reconcileTaskStatus({
        ...task,
        subtasks: (task.subtasks ?? []).map((subtask) => {
          if (subtask.number !== subtaskNumber) return subtask;
          const statusChangedAt = updates.status && updates.status !== subtask.status ? nowIso() : subtask.statusChangedAt;
          return {
            ...subtask,
            ...updates,
            actionType: updates.actionType === "" ? undefined : updates.actionType ?? subtask.actionType,
            statusChangedAt,
          };
        }),
      });
    }));
  }

  function inlineSubtaskDraftKey(taskId: string, subtaskNumber: number) {
    return `${taskId}:${subtaskNumber}`;
  }

  function updateInlineSubtaskDraft(taskId: string, subtaskNumber: number, value: string) {
    setInlineSubtaskDrafts((current) => ({ ...current, [inlineSubtaskDraftKey(taskId, subtaskNumber)]: value }));
  }

  function commitInlineSubtaskDraft(taskId: string, subtaskNumber: number, fallbackTitle: string) {
    const key = inlineSubtaskDraftKey(taskId, subtaskNumber);
    const nextTitle = inlineSubtaskDrafts[key];
    if (nextTitle === undefined || nextTitle === fallbackTitle) return;
    updateTaskSubtask(taskId, subtaskNumber, { title: nextTitle });
    setInlineSubtaskDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function deleteTaskSubtask(taskId: string, subtaskNumber: number) {
    const task = tasks.find((item) => item.id === taskId);
    const subtask = task?.subtasks?.find((item) => item.number === subtaskNumber);
    const confirmed = window.confirm(`למחוק את צעד הטיפול${subtask?.title ? ` "${subtask.title}"` : ""}?`);
    if (!confirmed) return;

    setTasks((current) => current.map((currentTask) => (
      currentTask.id === taskId
        ? reconcileTaskStatus({
          ...currentTask,
          subtasks: (currentTask.subtasks ?? []).filter((item) => item.number !== subtaskNumber),
        })
        : currentTask
    )));
  }

  function addTaskSubtask(task: Task) {
    const subtasks = task.subtasks ?? [];
    const number = nextSubtaskNumber(subtasks);
    const createdAt = nowIso();
    const newSubtask: TaskSubtask = {
      id: createSubtaskId(task.id, number),
      number,
      title: "",
      status: "open",
      createdAt,
      statusChangedAt: createdAt,
    };

    setTasks((current) => current.map((currentTask) => (
      currentTask.id === task.id
        ? reconcileTaskStatus({ ...currentTask, subtasks: [...(currentTask.subtasks ?? []), newSubtask] })
        : currentTask
    )));
    setExpandedSubtaskTaskIds((current) => new Set(current).add(task.id));
  }

  function createTaskFromAssistant(action: Extract<AssistantProposedAction, { type: "create_task" }>) {
    const prefix = action.task.prefix ?? "P";
    const title = action.task.title.trim();
    const dueDate = action.task.dueDate && action.task.dueDate >= todayIso() ? action.task.dueDate : undefined;
    if (!title) throw new Error("הפעולה לא כוללת שם משימה.");

    setTasks((current) => {
      const nextNumber = nextTaskNumber(current, prefix);
      const taskId = `${prefix}${nextNumber}`;
      const createdAt = todayIso();
      const statusChangedAt = nowIso();
      return mergeUniqueTasks([...current, {
        id: taskId,
        prefix,
        number: nextNumber,
        title,
        category: action.task.category?.trim() || (prefix === "W" ? "עבודה" : "אישי"),
        actionType: action.task.actionType?.trim() || undefined,
        priority: action.task.priority ?? "normal",
        status: "open",
        dueDate,
        notes: action.task.notes?.trim() || undefined,
        createdAt,
        statusChangedAt,
        subtasks: [],
      }]);
    });
  }

  function addSubtaskFromAssistant(action: Extract<AssistantProposedAction, { type: "add_subtask" }>) {
    const title = action.subtask.title.trim();
    if (!title) throw new Error("הפעולה לא כוללת שם צעד טיפול.");

    setTasks((current) => current.map((task) => {
      if (task.id !== action.taskId) return task;
      const subtasks = task.subtasks ?? [];
      const number = nextSubtaskNumber(subtasks);
      const createdAt = nowIso();
      return reconcileTaskStatus({
        ...task,
        subtasks: [...subtasks, {
          id: createSubtaskId(task.id, number),
          number,
          title,
          status: "open",
          actionType: action.subtask.actionType?.trim() || undefined,
          createdAt,
          statusChangedAt: createdAt,
        }],
      });
    }));
    setExpandedSubtaskTaskIds((current) => new Set(current).add(action.taskId));
  }

  async function refreshDeletedAssistantThreadList() {
    if (!cloudUser) return;
    setAssistantRestoreStatus("בודק שיחות שנמחקו...");
    try {
      const threads = await fetchDeletedAssistantThreads(cloudUser);
      setDeletedAssistantThreads(threads);
      setAssistantRestoreStatus(threads.length ? `יש ${threads.length} שיחות שניתן לשחזר.` : "אין שיחות מחוקות לשחזור.");
    } catch (error) {
      setAssistantRestoreStatus(`לא הצלחתי לטעון שיחות לשחזור: ${errorMessage(error)}`);
    }
  }

  async function restoreDeletedAssistantThread(threadId: string) {
    setAssistantRestoreStatus("משחזר שיחת AI...");
    try {
      const thread = await restoreAssistantThread(threadId);
      const messages = await fetchAssistantMessages(thread.id);
      setAssistantThreadId(thread.id);
      setAssistantMessages(messages);
      setIsAssistantOpen(true);
      await refreshDeletedAssistantThreadList();
      setAssistantStatus("שיחת ה-AI שוחזרה.");
      setAssistantRestoreStatus("השיחה שוחזרה ונפתחה בצ׳ט.");
    } catch (error) {
      setAssistantRestoreStatus(`השחזור נכשל: ${errorMessage(error)}`);
    }
  }

  async function clearAssistantHistory(options: { confirmBeforeDelete: boolean }) {
    if (!cloudUser) {
      setAssistantStatus("יש להתחבר לענן כדי למחוק את היסטוריית הצ׳ט.");
      return;
    }

    if (options.confirmBeforeDelete) {
      const confirmed = window.confirm("למחוק את שיחת ה-AI הפעילה? היא תישמר ברקע ל-30 יום ותוכל לשחזר אותה מההגדרות.");
      if (!confirmed) return;
    }

    setAssistantStatus("מעביר את שיחת ה-AI לשחזור ל-30 יום...");
    await softDeleteAssistantHistory(cloudUser);
    const thread = await getOrCreateAssistantThread(cloudUser);
    setAssistantThreadId(thread.id);
    setAssistantMessages([]);
    await refreshDeletedAssistantThreadList();
    setAssistantStatus("שיחת ה-AI נמחקה מהתצוגה ונשמרה לשחזור ל-30 יום.");
  }

  async function approveAssistantAction(message: AssistantMessage) {
    if (!message.proposedAction) return;

    try {
      if (message.proposedAction.type === "create_task") {
        createTaskFromAssistant(message.proposedAction);
      } else if (message.proposedAction.type === "update_task_status") {
        updateStatus(message.proposedAction.taskId, message.proposedAction.status);
      } else if (message.proposedAction.type === "add_subtask") {
        addSubtaskFromAssistant(message.proposedAction);
      } else if (message.proposedAction.type === "update_subtask_status") {
        updateTaskSubtask(message.proposedAction.taskId, message.proposedAction.subtaskNumber, { status: message.proposedAction.status });
      } else if (message.proposedAction.type === "filter_tasks") {
        setQuery(message.proposedAction.filter.query ?? "");
        setStatusFilter((message.proposedAction.filter.statusFilter as TaskFilter | undefined) ?? "active");
        setPrefixFilter((message.proposedAction.filter.prefixFilter as TaskPrefix | "all" | undefined) ?? "all");
        setTopicFilter(message.proposedAction.filter.topicFilter ?? "all");
        setActionFilter(message.proposedAction.filter.actionFilter ?? "all");
        setActiveView("tasks");
      } else if (message.proposedAction.type === "delete_assistant_history") {
        await clearAssistantHistory({ confirmBeforeDelete: false });
        return;
      }

      setAssistantMessages((current) => current.map((item) => item.id === message.id ? { ...item, actionStatus: "done" } : item));
      await updateAssistantMessageActionStatus(message.id, "done");
      setAssistantStatus("הפעולה בוצעה.");
    } catch (error) {
      setAssistantMessages((current) => current.map((item) => item.id === message.id ? { ...item, actionStatus: "failed" } : item));
      await updateAssistantMessageActionStatus(message.id, "failed").catch(() => undefined);
      setAssistantStatus(`הפעולה נכשלה: ${errorMessage(error)}`);
    }
  }

  async function sendAssistantMessage(event: FormEvent) {
    event.preventDefault();
    const message = assistantInput.trim();
    if (!message || !cloudUser || !assistantThreadId || !supabase) return;

    setAssistantInput("");
    setAssistantIsSending(true);
    setAssistantStatus("שולח לעוזר...");

    try {
      const userMessage = await addAssistantMessage(assistantThreadId, cloudUser, "user", message);
      setAssistantMessages((current) => [...current, userMessage]);

      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error("אין session פעיל.");

      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          tasks,
          taxonomy,
          recentMessages: assistantMessages.slice(-8).map((item) => ({ role: item.role, content: item.content })),
        }),
      });

      const data = await response.json() as {
        reply?: string;
        proposedAction?: AssistantProposedAction;
        error?: string;
        visibleEnvironmentKeys?: string[];
      };
      if (!response.ok || data.error) throw new Error(data.error ?? "העוזר החזיר שגיאה.");

      const assistantMessage = await addAssistantMessage(
        assistantThreadId,
        cloudUser,
        "assistant",
        data.reply ?? "לא התקבלה תשובה.",
        data.proposedAction,
        data.proposedAction ? "proposed" : undefined,
      );
      setAssistantMessages((current) => [...current, assistantMessage]);
      setAssistantStatus(data.proposedAction ? "העוזר הציע פעולה שמחכה לאישור." : "העוזר ענה.");
    } catch (error) {
      setAssistantStatus(`שגיאת צ׳ט: ${errorMessage(error)}`);
    } finally {
      setAssistantIsSending(false);
    }
  }

  function assistantActionDescription(action: AssistantProposedAction) {
    if (action.type === "delete_assistant_history") return "העברת שיחת ה-AI לשחזור למשך 30 יום";
    if (action.type === "create_task") return `יצירת משימה: ${action.task.title}`;
    if (action.type === "update_task_status") return `שינוי ${action.taskId} לסטטוס ${statusLabels[action.status]}`;
    if (action.type === "add_subtask") return `הוספת צעד טיפול ל-${action.taskId}: ${action.subtask.title}`;
    if (action.type === "update_subtask_status") return `שינוי צעד ${action.subtaskNumber} ב-${action.taskId} ל-${subtaskStatusLabels[action.status]}`;
    return "החלת סינון על רשימת המשימות";
  }

  function updateTaskDraft(updates: Partial<TaskDraft>) {
    setTaskEditor((current) => {
      if (!current) return current;
      const draft = { ...current.draft, ...updates };
      return { ...current, draft: { ...draft, status: effectiveTaskStatus(draft.status, draft.subtasks) } };
    });
  }

  function updateTaskDraftSubtasks(updater: (subtasks: TaskSubtask[], editor: Exclude<TaskEditorState, null>) => TaskSubtask[]) {
    setTaskEditor((current) => {
      if (!current) return current;
      const subtasks = updater(current.draft.subtasks, current);
      const status = effectiveTaskStatus(current.draft.status, subtasks);
      return {
        ...current,
        draft: {
          ...current.draft,
          status,
          subtasks,
        },
      };
    });
  }

  function addDraftSubtask() {
    updateTaskDraftSubtasks((subtasks, editor) => {
      const number = nextSubtaskNumber(subtasks);
      const parentId = editor.mode === "edit" ? editor.taskId : `${editor.draft.prefix}0`;
      return [...subtasks, {
        id: createSubtaskId(parentId, number),
        number,
        title: "",
        status: "open",
        actionType: "",
        createdAt: nowIso(),
        statusChangedAt: nowIso(),
      }];
    });
  }

  function updateDraftSubtask(number: number, updates: Partial<TaskSubtask>) {
    updateTaskDraftSubtasks((subtasks) => subtasks.map((subtask) => {
      if (subtask.number !== number) return subtask;
      const statusChangedAt = updates.status && updates.status !== subtask.status ? nowIso() : subtask.statusChangedAt;
      return {
        ...subtask,
        ...updates,
        statusChangedAt,
      };
    }));
  }

  function cancelDraftSubtask(number: number) {
    updateDraftSubtask(number, { status: "cancelled" });
  }

  function deleteDraftSubtask(number: number) {
    const subtask = taskEditor?.draft.subtasks.find((item) => item.number === number);
    const confirmed = window.confirm(`למחוק את צעד הטיפול${subtask?.title ? ` "${subtask.title}"` : ""}?`);
    if (!confirmed) return;
    updateTaskDraftSubtasks((subtasks) => subtasks.filter((item) => item.number !== number));
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
    const incompleteSubtask = draft.subtasks.find((subtask) => subtask.status !== "cancelled" && !subtask.title.trim());
    if (incompleteSubtask) {
      setTaskEditorError("יש למלא שם לכל צעד טיפול פעיל, או לבטל אותו.");
      return;
    }
    if (taskEditor.mode === "create" && draft.dueDate && draft.dueDate < todayIso()) {
      setTaskEditorError("תאריך יעד למשימה חדשה לא יכול להיות בעבר.");
      return;
    }

    setTasks((current) => {
      if (taskEditor.mode === "create") {
        const nextNumber = nextTaskNumber(current, draft.prefix);
        const taskId = `${draft.prefix}${nextNumber}`;
        const createdAt = todayIso();
        const statusChangedAt = nowIso();
        const subtasks = normalizeDraftSubtasks(draft.subtasks, taskId);
        const status = effectiveTaskStatus(draft.status, subtasks);
        return mergeUniqueTasks([...current, {
          id: taskId,
          prefix: draft.prefix,
          number: nextNumber,
          title,
          category,
          actionType: draft.actionType.trim() || undefined,
          priority: draft.priority,
          status,
          dueDate: draft.dueDate || undefined,
          notes: draft.notes.trim() || undefined,
          createdAt,
          completedAt: status === "done" ? createdAt : undefined,
          statusChangedAt,
          subtasks,
        }]);
      }

      return current.map((task) => {
        if (task.id !== taskEditor.taskId) return task;
        const subtasks = normalizeDraftSubtasks(draft.subtasks, task.id);
        const status = effectiveTaskStatus(draft.status, subtasks);
        const statusChangedAt = task.status === status ? task.statusChangedAt : nowIso();
        return {
          ...task,
          title,
          category,
          actionType: draft.actionType.trim() || undefined,
          priority: draft.priority,
          status,
          dueDate: draft.dueDate || undefined,
          notes: draft.notes.trim() || undefined,
          completedAt: status === "done" ? (task.status === "done" ? task.completedAt ?? todayIso() : todayIso()) : undefined,
          statusChangedAt,
          subtasks,
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

  function applyTopicRename(prefix: TaskPrefix, topic: string, nextName: string) {
    const cleanName = nextName.trim();
    if (!cleanName || cleanName === topic) return;
    setTaxonomy((current) => ({
      ...current,
      topics: {
        ...current.topics,
        [prefix]: replaceValue(current.topics[prefix], topic, cleanName),
      },
    }));
    setTasks((current) => current.map((task) => (
      task.prefix === prefix && task.category === topic ? { ...task, category: cleanName } : task
    )));
    setTopicFilter((current) => current === topic ? cleanName : current);
  }

  function applyActionRename(action: string, nextName: string) {
    const cleanName = nextName.trim();
    if (!cleanName || cleanName === action) return;
    setTaxonomy((current) => ({
      ...current,
      actions: replaceValue(current.actions, action, cleanName),
    }));
    setTasks((current) => current.map((task) => ({
      ...task,
      actionType: task.actionType === action ? cleanName : task.actionType,
      subtasks: task.subtasks?.map((subtask) => (
        subtask.actionType === action ? { ...subtask, actionType: cleanName } : subtask
      )),
    })));
    setActionFilter((current) => current === action ? cleanName : current);
  }

  function startEditTopic(prefix: TaskPrefix, topic: string) {
    setEditingTaxonomyItem({ type: "topic", prefix, name: topic, value: topic });
  }

  function startEditAction(action: string) {
    setEditingTaxonomyItem({ type: "action", name: action, value: action });
  }

  function updateEditingTaxonomyValue(value: string) {
    setEditingTaxonomyItem((current) => current ? { ...current, value } : current);
  }

  function cancelEditingTaxonomyItem() {
    setEditingTaxonomyItem(null);
  }

  function saveEditingTaxonomyItem() {
    if (!editingTaxonomyItem) return;
    if (editingTaxonomyItem.type === "topic") {
      applyTopicRename(editingTaxonomyItem.prefix, editingTaxonomyItem.name, editingTaxonomyItem.value);
    } else {
      applyActionRename(editingTaxonomyItem.name, editingTaxonomyItem.value);
    }
    setEditingTaxonomyItem(null);
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
    setAuthIsSending(true);
    setCloudStatus("שולח קישור התחברות למייל...");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: appOrigin(),
        },
      });

      setCloudStatus(error ? `שליחת קישור ההתחברות נכשלה: ${error.message}` : "נשלח קישור התחברות למייל.");
    } finally {
      setAuthIsSending(false);
    }
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
    setAssistantThreadId(null);
    setAssistantMessages([]);
    setAssistantStatus("הצ׳ט ייטען אחרי התחברות לענן.");
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

  function renderSubtasksPreview(task: Task) {
    const subtasks = task.subtasks ?? [];
    if (subtasks.length === 0) return null;

    const expanded = expandedSubtaskTaskIds.has(task.id);
    const progress = subtaskProgress(subtasks);
    return (
      <div className="subtasks-preview">
        <button
          type="button"
          className="subtasks-toggle"
          onClick={() => toggleTaskSubtasks(task.id)}
          aria-expanded={expanded}
          aria-controls={`subtasks-preview-${task.id}`}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span>צעדי טיפול</span>
        </button>
        {expanded && (
          <div className="subtasks-preview-panel" id={`subtasks-preview-${task.id}`}>
            <div className="subtasks-preview-summary" aria-label="סיכום צעדי טיפול">
              <span>{progress.total} פעילים</span>
              <span>{progress.done} בוצעו</span>
              {progress.cancelled > 0 && <span>{progress.cancelled} בוטלו</span>}
            </div>
            <button type="button" className="subtask-add-inline" onClick={() => addTaskSubtask(task)} aria-label={`הוספת צעד טיפול ל-${task.title}`}>
              <span aria-hidden="true">+</span>
              <span>צעד טיפול</span>
            </button>
            <ul className="subtasks-preview-list">
              {subtasks.map((subtask) => (
                <li className={`subtasks-preview-item status-${subtask.status}`} key={subtask.id}>
                  <input
                    {...freeTextInputProps}
                    value={inlineSubtaskDrafts[inlineSubtaskDraftKey(task.id, subtask.number)] ?? subtask.title}
                    onChange={(event) => updateInlineSubtaskDraft(task.id, subtask.number, event.target.value)}
                    onBlur={() => commitInlineSubtaskDraft(task.id, subtask.number, subtask.title)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitInlineSubtaskDraft(task.id, subtask.number, subtask.title);
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="צעד טיפול חדש"
                    aria-label={subtask.title ? `שם צעד טיפול ${subtask.title}` : "שם צעד טיפול חדש"}
                  />
                  <select
                    value={subtask.actionType ?? ""}
                    onChange={(event) => updateTaskSubtask(task.id, subtask.number, { actionType: event.target.value })}
                    aria-label={subtask.title ? `פעולה עבור ${subtask.title}` : "פעולה עבור צעד טיפול חדש"}
                  >
                    <option value="">ללא פעולה</option>
                    {actionOptions.map((action) => <option value={action} key={action}>{action}</option>)}
                  </select>
                  <select
                    value={subtask.status}
                    onChange={(event) => updateTaskSubtask(task.id, subtask.number, { status: event.target.value as TaskSubtaskStatus })}
                    aria-label={subtask.title ? `סטטוס עבור ${subtask.title}` : "סטטוס עבור צעד טיפול חדש"}
                  >
                    {Object.entries(subtaskStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                  </select>
                  <button
                    type="button"
                    className="subtask-delete"
                    onClick={() => deleteTaskSubtask(task.id, subtask.number)}
                    aria-label={subtask.title ? `מחיקת צעד טיפול ${subtask.title}` : "מחיקת צעד טיפול חדש"}
                    title="מחיקה"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const pageTitle = displayName ? `המשימות של ${displayName}` : "המשימות שלי";
  const authStatusClassName = cloudStatus.includes("נכשלה") || cloudStatus.includes("שגיאה") || cloudStatus.includes("לא מוגדר")
    ? "auth-status auth-status-error"
    : "auth-status";

  return (
    <main className={activeView === "kanban" ? "kanban-main" : undefined}>
      <header className="hero">
        <div>
          <p className="eyebrow">מעקב משימות אישי</p>
          <h1>{pageTitle}</h1>
          <p className="subtitle">ניהול פשוט, עקבי ונגיש מכל מכשיר</p>
        </div>
        {cloudUser && (
          <button className="settings-button" onClick={() => setIsSettingsOpen(true)} aria-label="פתיחת הגדרות">
            <span aria-hidden="true">⚙</span>
            הגדרות
          </button>
        )}
      </header>

      {!authChecked ? (
        <LoadingSkeleton />
      ) : !cloudUser ? (
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
                  <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="name@example.com" aria-label="כתובת מייל להתחברות" disabled={authIsSending} />
                </label>
                <button type="submit" disabled={authIsSending || !authEmail.trim()}>{authIsSending ? "שולח..." : "שליחת קישור התחברות"}</button>
              </form>
            ) : (
              <code>NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>
            )}
            <p className={authStatusClassName}>{cloudStatus}</p>
          </div>
        </section>
      ) : !isCloudReady ? (
        <LoadingSkeleton />
      ) : (
        <>
          <section className="stats" aria-label="סיכום משימות">
            <button onClick={() => showTaskList("active")}><strong>{counts.active}</strong><span>פעילות</span></button>
            <button onClick={() => showTaskList("waiting")}><strong>{counts.waiting}</strong><span>ממתינות</span></button>
            <button onClick={() => showTaskList("done")}><strong>{counts.done}</strong><span>הושלמו</span></button>
          </section>

          {cloudUser && !displayName && (
            <section className="app-notifications" aria-label="השלמת פרופיל">
              <article className="app-notification notification-neutral">
                <div>
                  <strong>איך לקרוא לך בכותרת?</strong>
                  <span>אפשר להגדיר שם קצר, למשל ויצמן, כדי שהכותרת תהיה אישית יותר.</span>
                </div>
                <button onClick={() => {
                  setSettingsTab("appearance");
                  setIsSettingsOpen(true);
                }}>הגדרת שם</button>
              </article>
            </section>
          )}

          {appNotifications.length > 0 && (
            <section className="app-notifications" aria-label="התראות פעילות" aria-live="polite">
              {appNotifications.map((notification) => (
                <article className={`app-notification notification-${notification.tone}`} key={notification.id}>
                  <div>
                    <strong>{notification.title}</strong>
                    <span>{notification.body}</span>
                  </div>
                  <button onClick={() => applyNotificationAction(notification)}>{notification.actionLabel}</button>
                </article>
              ))}
            </section>
          )}

          <nav className="view-tabs" aria-label="מעבר בין תצוגות">
            <button className={activeView === "tasks" ? "active" : ""} onClick={() => setActiveView("tasks")}>משימות</button>
            <button className={`kanban-view-tab ${activeView === "kanban" ? "active" : ""}`} onClick={() => setActiveView("kanban")}>לוח Kanban</button>
            <button className={activeView === "stats" ? "active" : ""} onClick={() => setActiveView("stats")}>סטטיסטיקות</button>
          </nav>

          {activeView === "tasks" ? (
            <>
              <form className="panel quick-add" onSubmit={quickAddTask} aria-label="הוספה מהירה של משימה">
                <div>
                  <label htmlFor="quick-add-title">הוספה מהירה</label>
                  <input
                    {...freeTextInputProps}
                    id="quick-add-title"
                    value={quickAddTitle}
                    onChange={(event) => setQuickAddTitle(event.target.value)}
                    placeholder="מה צריך לעשות עכשיו?"
                    aria-describedby="quick-add-help"
                  />
                  <small id="quick-add-help">
                    Enter יוסיף משימה חדשה. פרטים מלאים אפשר להוסיף דרך כפתור הפלוס.
                  </small>
                </div>
                <button type="submit" disabled={!quickAddTitle.trim()}>הוספה</button>
              </form>

              <section className="panel controls">
                <input {...freeTextInputProps} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="חיפוש משימה או מזהה, למשל P19" aria-label="חיפוש" />
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="סינון סטטוס">
                  <option value="active">משימות פעילות</option>
                  <option value="open">פתוחות</option>
                  <option value="in_progress">בטיפול</option>
                  <option value="waiting">ממתינות</option>
                  <option value="focused">במיקוד</option>
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

              {activeFilters.length > 0 && (
                <section className="active-filters" aria-label="סינון פעיל">
                  <div className="active-filters-summary">
                    <strong>סינון פעיל</strong>
                    <span>{activeFilters.length} תנאים מצמצמים את הרשימה</span>
                  </div>
                  <div className="active-filter-chips">
                    {activeFilters.map((filter) => (
                      <span className="active-filter-chip" key={filter.key}>{filter.label}</span>
                    ))}
                  </div>
                  <button type="button" onClick={clearTaskFilters}>ניקוי סינון</button>
                </section>
              )}

              <section className="quick-filters" aria-label="סינון מהיר">
                <button className={statusFilter === "today" ? "active" : ""} onClick={() => setStatusFilter("today")}>להיום</button>
                <button className={statusFilter === "week" ? "active" : ""} onClick={() => setStatusFilter("week")}>השבוע</button>
                <button className={statusFilter === "overdue" ? "active" : ""} onClick={() => setStatusFilter("overdue")}>באיחור</button>
                <button className={statusFilter === "no_due" ? "active" : ""} onClick={() => setStatusFilter("no_due")}>בלי יעד</button>
                <button className={statusFilter === "high" ? "active" : ""} onClick={() => setStatusFilter("high")}>גבוהה</button>
                <button className={statusFilter === "focused" ? "active" : ""} onClick={() => setStatusFilter("focused")}>במיקוד</button>
                <button className={statusFilter === "subtasks_open" ? "active" : ""} onClick={() => setStatusFilter("subtasks_open")}>צעדים פתוחים</button>
              </section>

              <section className="task-list" aria-live="polite">
                {filteredTasks.length === 0 && (
                  <div className="empty smart-empty">
                    <strong>{emptyTaskState.title}</strong>
                    <p>{emptyTaskState.body}</p>
                    <button type="button" onClick={emptyTaskState.action}>{emptyTaskState.actionLabel}</button>
                  </div>
                )}
                {filteredTasks.map((task) => (
                  <article className={`task-card status-${task.status}${isOverdue(task) ? " is-overdue" : ""}${subtaskProgress(task.subtasks).open >= 3 ? " has-open-subtasks" : ""}`} key={task.id}>
                    <button
                      className={`focus-button${task.focused ? " active" : ""}`}
                      aria-label={task.focused ? `הסרת ${task.title} ממיקוד` : `סימון ${task.title} במיקוד`}
                      aria-pressed={Boolean(task.focused)}
                      onClick={() => toggleTaskFocus(task.id)}
                      title={task.focused ? "הסרה ממיקוד" : "סימון במיקוד"}
                    >
                      ★
                    </button>
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
                        {taskStatusTimestampLabel(task) && <span className="status-timestamp">{taskStatusTimestampLabel(task)}</span>}
                        {subtaskProgressLabel(task.subtasks) && <span className="subtask-progress">{subtaskProgressLabel(task.subtasks)}</span>}
                      </div>
                      {task.notes && <p className="task-notes">{task.notes}</p>}
                      {renderSubtasksPreview(task)}
                    </div>
                    <div className="task-actions">
                      <select value={task.status} onChange={(e) => updateStatus(task.id, e.target.value as TaskStatus)} aria-label={`סטטוס ${task.title}`}>
                        {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                      </select>
                      <button className="edit-icon-button" onClick={() => openEditTask(task)} aria-label={`עריכת ${task.title}`} title="עריכה">
                        <span aria-hidden="true">✎</span>
                      </button>
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
                          <article className={`kanban-card status-${task.status}${isOverdue(task) ? " is-overdue" : ""}${subtaskProgress(task.subtasks).open >= 3 ? " has-open-subtasks" : ""}`} key={task.id}>
                            <button
                              className={`focus-button kanban-focus${task.focused ? " active" : ""}`}
                              aria-label={task.focused ? `הסרת ${task.title} ממיקוד` : `סימון ${task.title} במיקוד`}
                              aria-pressed={Boolean(task.focused)}
                              onClick={() => toggleTaskFocus(task.id)}
                              title={task.focused ? "הסרה ממיקוד" : "סימון במיקוד"}
                            >
                              ★
                            </button>
                            <div className="task-heading">
                              <span className="task-id">{task.id}</span>
                              <h3>{task.title}</h3>
                            </div>
                            <div className="meta">
                              <span>נושא {task.category}</span>
                              {task.actionType && <span>פעולה {task.actionType}</span>}
                              <span>עדיפות {priorityLabels[task.priority]}</span>
                              {task.dueDate && <span>יעד {formatDate(task.dueDate)}</span>}
                              {taskStatusTimestampLabel(task) && <span className="status-timestamp">{taskStatusTimestampLabel(task)}</span>}
                              {subtaskProgressLabel(task.subtasks) && <span className="subtask-progress">{subtaskProgressLabel(task.subtasks)}</span>}
                            </div>
                            {renderSubtasksPreview(task)}
                            <div className="kanban-actions">
                              <select value={task.status} onChange={(event) => updateStatus(task.id, event.target.value as TaskStatus)} aria-label={`סטטוס ${task.title}`}>
                                {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                              </select>
                              <button className="edit-icon-button" onClick={() => openEditTask(task)} aria-label={`עריכת ${task.title}`} title="עריכה">
                                <span aria-hidden="true">✎</span>
                              </button>
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

              <section className="panel period-summary-panel" aria-label={analytics.periodSummary.title}>
                <div>
                  <p className="eyebrow">{analytics.periodSummary.title}</p>
                  <h2>מה קרה בטווח הזה</h2>
                  <p>{analytics.periodSummary.body}</p>
                </div>
                <ul>
                  {analytics.periodSummary.highlights.map((item) => <li key={item}>{item}</li>)}
                </ul>
                <button onClick={() => applyAnalyticsAction(analytics.periodSummary.action)}>{analytics.periodSummary.actionLabel}</button>
              </section>

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
                <button type="button" className="metric metric-button" onClick={() => showTaskList("active")}><span>פעילות</span><strong>{statistics.active}</strong><small>פתוחות, בטיפול או ממתינות</small></button>
                <button type="button" className="metric metric-button metric-danger" onClick={() => showTaskList("overdue")}><span>באיחור</span><strong>{statistics.overdue}</strong><small>דורשות החלטה</small></button>
                <button type="button" className="metric metric-button metric-warn" onClick={() => showTaskList("waiting")}><span>ממתינות</span><strong>{analytics.waiting}</strong><small>תקועות על גורם חיצוני</small></button>
                <button type="button" className="metric metric-button" onClick={() => showTaskList("no_due")}><span>בלי תאריך יעד</span><strong>{statistics.withoutDueDate}</strong><small>כדאי למקד</small></button>
                <button type="button" className="metric metric-button" onClick={() => showTaskList("subtasks_open")}><span>צעדים פתוחים</span><strong>{analytics.openSubtasks}</strong><small>{analytics.withOpenSubtasks} משימות</small></button>
                <button type="button" className="metric metric-button metric-good" onClick={() => showTaskList("subtasks_open")}><span>צעדים נסגרו</span><strong>{analytics.completedSubtasksInRange}</strong><small>{analyticsRangeLabel()}</small></button>
                <div className="metric"><span>השלמת צעדים</span><strong>{analytics.subtaskCompletionRate}%</strong><small>{analytics.doneSubtasks}/{analytics.totalSubtasks} צעדים</small></div>
                <button type="button" className="metric metric-button metric-good" onClick={() => showTaskList("done")}><span>נסגרו בטווח</span><strong>{analytics.completedInRange}</strong><small>{analyticsRangeLabel()}</small></button>
                <button type="button" className="metric metric-button" onClick={() => showTaskList("all")}><span>כל המשימות</span><strong>{statistics.total}</strong><small>{statistics.done} הושלמו</small></button>
              </div>

              <div className="analytics-layout">
                <div className="analytics-main">
                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>{completionChartTitle()}</h2>
                      <span>{completionChartSubtitle()}</span>
                    </div>
                    <p className="chart-context">המדד מבוסס על מועד הסגירה בפועל, כלומר הרגע שבו המשימה עברה לסטטוס בוצעה. הוא לא משתמש בתאריך היעד או בתאריך יצירת המשימה.</p>
                    {analytics.hasRecentCompletions ? (
                      <div className="week-chart" aria-label={completionChartTitle()}>
                        {analytics.completionTrend.map((row) => (
                          <div className="day-column" key={row.key ?? row.label}>
                            <div className="vertical-track"><div style={{ height: `${(row.value / maxTrendValue()) * 100}%` }} /></div>
                            <strong>{row.value}</strong>
                            <span>{row.label}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="chart-empty-state">
                        <strong>{completionChartEmptyTitle()}</strong>
                        <p>{completionChartEmptyBody()}</p>
                      </div>
                    )}
                  </section>

                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>צעדי טיפול לפי פעולה</h2>
                      <span>צעדים פתוחים בלבד</span>
                    </div>
                    {analytics.subtasksByAction.length === 0 ? (
                      <p className="muted-line">אין כרגע צעדי טיפול פתוחים.</p>
                    ) : analytics.subtasksByAction.slice(0, 8).map((row) => (
                      <div className="bar-row" key={row.label}>
                        <span>{row.label}</span>
                        <div className="bar-track"><div style={{ width: `${(row.value / maxValue(analytics.subtasksByAction)) * 100}%` }} /></div>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </section>

                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>משימות עם צעדי טיפול פתוחים</h2>
                      <span>איפה כדאי להתחיל לפרק</span>
                    </div>
                    {analytics.tasksByOpenSubtasks.length === 0 ? (
                      <p className="muted-line">אין משימות עם צעדי טיפול פתוחים.</p>
                    ) : analytics.tasksByOpenSubtasks.map((row) => (
                      <button className="subtask-load-row" key={row.task.id} onClick={() => focusTask(row.task.id)}>
                        <span className="task-id">{row.task.id}</span>
                        <strong>{row.task.title}</strong>
                        <span>{row.value} צעדים פתוחים</span>
                      </button>
                    ))}
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

      {cloudUser && (
        <>
          <button
            className="assistant-floating-button"
            onClick={() => setIsAssistantOpen((current) => !current)}
            aria-label={isAssistantOpen ? "סגירת צ׳ט AI" : "פתיחת צ׳ט AI"}
          >
            AI
          </button>

          {isAssistantOpen && (
            <section className="assistant-chat" aria-label="צ׳ט AI למשימות">
              <div className="assistant-chat-header">
                <div>
                  <p className="eyebrow">עוזר משימות</p>
                  <h2>צ׳ט AI</h2>
                  <span>פעולות מוצעות בלבד, וכל שינוי דורש אישור שלך.</span>
                </div>
                <button className="icon-button" onClick={() => setIsAssistantOpen(false)} aria-label="סגירת צ׳ט AI">×</button>
              </div>

              <div className="assistant-messages" aria-live="polite" ref={assistantMessagesRef}>
                {assistantMessages.length === 0 ? (
                  <div className="assistant-empty">
                    <strong>אפשר להתחיל בשאלה קצרה</strong>
                    <span>למשל: מה כדאי לעשות עכשיו? או תוסיף משימה להתקשר לרואה חשבון.</span>
                  </div>
                ) : assistantMessages.map((message) => (
                  <article className={`assistant-message role-${message.role}`} key={message.id}>
                    <span className="assistant-message-meta">{message.role === "user" ? "אני" : "עוזר המשימות"}</span>
                    <p>{message.content}</p>
                    {message.proposedAction && (
                      <div className="assistant-action-card">
                        <span>{assistantActionDescription(message.proposedAction)}</span>
                        <button
                          onClick={() => approveAssistantAction(message)}
                          disabled={message.actionStatus === "done"}
                        >
                          {message.actionStatus === "done" ? "בוצע" : message.proposedAction.label}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>

              <p className="assistant-status">{assistantStatus}</p>

              <form className="assistant-form" onSubmit={sendAssistantMessage}>
                <input
                  {...freeTextInputProps}
                  value={assistantInput}
                  onChange={(event) => setAssistantInput(event.target.value)}
                  placeholder="כתוב לעוזר המשימות..."
                  aria-label="הודעה לצ׳ט AI"
                  disabled={assistantIsSending || !assistantThreadId}
                />
                <button type="submit" disabled={assistantIsSending || !assistantInput.trim() || !assistantThreadId}>
                  שליחה
                </button>
              </form>
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
                <h2>{settingsTab === "appearance" ? "תצוגה" : settingsTab === "taxonomy" ? "נושאים ופעולות" : settingsTab === "notifications" ? "התראות" : "חיבור, סנכרון וגיבוי"}</h2>
              </div>
              <button className="icon-button" onClick={() => setIsSettingsOpen(false)} aria-label="סגירת הגדרות">×</button>
            </div>

            <div className="settings-tabs" aria-label="אזורי הגדרות">
              <button className={settingsTab === "appearance" ? "active" : ""} onClick={() => setSettingsTab("appearance")}>
                תצוגה
              </button>
              <button className={settingsTab === "taxonomy" ? "active" : ""} onClick={() => setSettingsTab("taxonomy")}>
                נושאים ופעולות
              </button>
              <button className={settingsTab === "notifications" ? "active" : ""} onClick={() => setSettingsTab("notifications")}>
                התראות
              </button>
              <button className={settingsTab === "sync" ? "active" : ""} onClick={() => setSettingsTab("sync")}>
                חיבור, סנכרון וגיבוי
              </button>
            </div>

            <section className="data-view" aria-label="גיבוי ושחזור נתונים">
              {settingsTab === "appearance" ? (
              <section className="panel appearance-panel">
                <div className="panel-heading">
                  <div>
                    <h2>תצוגה</h2>
                    <span>בחירת מצב צבעים לאפליקציה. הבחירה נשמרת במכשיר הזה.</span>
                  </div>
                </div>
                <div className="theme-options" role="radiogroup" aria-label="בחירת מצב תצוגה">
                  <button
                    type="button"
                    className={theme === "light" ? "active" : ""}
                    onClick={() => setTheme("light")}
                    role="radio"
                    aria-checked={theme === "light"}
                  >
                    <span aria-hidden="true">☀</span>
                    <strong>מצב בהיר</strong>
                    <small>רקע בהיר וניגודיות רגילה לעבודה ביום.</small>
                  </button>
                  <button
                    type="button"
                    className={theme === "dark" ? "active" : ""}
                    onClick={() => setTheme("dark")}
                    role="radio"
                    aria-checked={theme === "dark"}
                  >
                    <span aria-hidden="true">◐</span>
                    <strong>מצב כהה</strong>
                    <small>רקע כהה ונעים יותר לעבודה בלילה.</small>
                  </button>
                </div>
                <form className="profile-settings-form" onSubmit={saveDisplayName}>
                  <label>
                    <span>שם שיופיע בכותרת</span>
                    <input
                      {...freeTextInputProps}
                      value={displayNameDraft}
                      onChange={(event) => setDisplayNameDraft(event.target.value)}
                      placeholder={displayNameFromUser(cloudUser) || "לדוגמה: ויצמן"}
                      aria-label="שם שיופיע בכותרת הראשית"
                    />
                  </label>
                  <button type="submit">שמירת שם</button>
                  <p>{userSettingsStatus}</p>
                </form>
              </section>
              ) : settingsTab === "taxonomy" ? (
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
                {editingTaxonomyItem && (
                  <form className="taxonomy-edit-form" onSubmit={(event) => {
                    event.preventDefault();
                    saveEditingTaxonomyItem();
                  }}>
                    <label>
                      <span>{editingTaxonomyItem.type === "topic" ? "עריכת נושא" : "עריכת פעולה"}</span>
                      <input
                        {...freeTextInputProps}
                        value={editingTaxonomyItem.value}
                        onChange={(event) => updateEditingTaxonomyValue(event.target.value)}
                        aria-label={editingTaxonomyItem.type === "topic" ? "שם נושא חדש" : "שם פעולה חדש"}
                        autoFocus
                      />
                    </label>
                    <button type="submit">שמירה</button>
                    <button type="button" className="secondary-action" onClick={cancelEditingTaxonomyItem}>ביטול</button>
                  </form>
                )}

                {taxonomyMode === "topics" ? (
                  <div className="taxonomy-manager">
                    <form className="taxonomy-form" onSubmit={addTopic}>
                      <select value={newTopicPrefix} onChange={(event) => setNewTopicPrefix(event.target.value as TaskPrefix)} aria-label="סוג נושא">
                        <option value="P">אישי</option>
                        <option value="W">עבודה</option>
                      </select>
                      <input {...freeTextInputProps} value={newTopicName} onChange={(event) => setNewTopicName(event.target.value)} placeholder="שם נושא חדש" aria-label="שם נושא חדש" />
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
                                <button type="button" onClick={() => startEditTopic(prefix, topic)} aria-label={`עריכת נושא ${topic}`}>✎</button>
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
                      <input {...freeTextInputProps} value={newActionName} onChange={(event) => setNewActionName(event.target.value)} placeholder="שם פעולה חדשה" aria-label="שם פעולה חדשה" />
                      <button type="submit">הוספת פעולה</button>
                    </form>
                    <div className="taxonomy-chips">
                      {actionOptions.map((action) => (
                        <span className="taxonomy-chip" key={action}>
                          {action}
                          <button type="button" onClick={() => startEditAction(action)} aria-label={`עריכת פעולה ${action}`}>✎</button>
                          <button onClick={() => removeAction(action)} aria-label={`מחיקת פעולה ${action}`}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              ) : settingsTab === "notifications" ? (
              <section className="panel notification-settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>העדפות התראות</h2>
                    <span>בחר אילו התראות יופיעו בראש האפליקציה.</span>
                  </div>
                </div>
                <label className="notification-setting analytics-threshold-setting">
                  <span>
                    <strong>סף משימה תקועה</strong>
                    <small>משימה פעילה שלא שינתה סטטוס מעל מספר הימים הזה תופיע בתובנות כתקועה.</small>
                  </span>
                  <input
                    type="number"
                    min="1"
                    max="120"
                    value={stuckThresholdDays}
                    onChange={(event) => updateStuckThresholdDays(event.target.value)}
                    aria-label="סף ימים למשימה תקועה"
                  />
                </label>
                <div className="notification-settings-list">
                  <label className="notification-setting">
                    <input
                      type="checkbox"
                      checked={notificationPreferences.overdue}
                      onChange={(event) => updateNotificationPreference("overdue", event.target.checked)}
                    />
                    <span>
                      <strong>משימות באיחור</strong>
                      <small>התראה כשיש משימות פעילות שתאריך היעד שלהן עבר.</small>
                    </span>
                  </label>
                  <label className="notification-setting">
                    <input
                      type="checkbox"
                      checked={notificationPreferences.openSubtasks}
                      onChange={(event) => updateNotificationPreference("openSubtasks", event.target.checked)}
                    />
                    <span>
                      <strong>צעדי טיפול פתוחים</strong>
                      <small>התראה כשיש צעדי טיפול שעדיין לא בוצעו בתוך משימות פעילות.</small>
                    </span>
                  </label>
                  <label className="notification-setting">
                    <input
                      type="checkbox"
                      checked={notificationPreferences.noWeeklyClosures}
                      onChange={(event) => updateNotificationPreference("noWeeklyClosures", event.target.checked)}
                    />
                    <span>
                      <strong>אין סגירות השבוע</strong>
                      <small>התראה כשיש משימות פעילות אבל לא נסגרה משימה בשבעת הימים האחרונים.</small>
                    </span>
                  </label>
                  <label className="notification-setting">
                    <input
                      type="checkbox"
                      checked={notificationPreferences.waiting}
                      onChange={(event) => updateNotificationPreference("waiting", event.target.checked)}
                    />
                    <span>
                      <strong>משימות ממתינות</strong>
                      <small>התראה כשיש משימות שמחכות לגורם חיצוני או החלטה.</small>
                    </span>
                  </label>
                  <label className="notification-setting">
                    <input
                      type="checkbox"
                      checked={notificationPreferences.dueSoon}
                      onChange={(event) => updateNotificationPreference("dueSoon", event.target.checked)}
                    />
                    <span>
                      <strong>תאריך יעד מתקרב</strong>
                      <small>התראה על משימות שתאריך היעד שלהן בשבעת הימים הקרובים.</small>
                    </span>
                  </label>
                </div>
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

              {cloudUser && (
                <section className="panel danger-panel">
                  <div>
                    <h2>היסטוריית צ׳ט AI</h2>
                    <p>הסרת השיחה הפעילה מהתצוגה ושמירה ברקע ל-30 יום לשחזור אישי. המשימות, הנושאים, הפעולות והגיבויים לא יושפעו.</p>
                  </div>
                  <button onClick={() => clearAssistantHistory({ confirmBeforeDelete: true })}>מחיקת שיחת AI</button>
                </section>
              )}

              {cloudUser && (
                <section className="panel assistant-restore-panel">
                  <div className="devices-header">
                    <div>
                      <h2>שחזור שיחות AI</h2>
                      <p>{assistantRestoreStatus || "שיחות שנמחקו נשמרות כאן עד 30 יום."}</p>
                    </div>
                    <button onClick={refreshDeletedAssistantThreadList}>רענון שחזור</button>
                  </div>
                  <div className="assistant-restore-list" aria-label="שיחות AI שנמחקו">
                    {deletedAssistantThreads.length === 0 ? (
                      <p className="devices-empty">אין שיחות מחוקות לשחזור.</p>
                    ) : deletedAssistantThreads.map((thread) => (
                      <article className="assistant-restore-card" key={thread.id}>
                        <div>
                          <h3>{thread.title}</h3>
                          {thread.deletedAt && <p>נמחקה: {formatDateTime(thread.deletedAt)}</p>}
                          {thread.purgeAfter && <p>זמינה לשחזור עד: {formatDateTime(thread.purgeAfter)}</p>}
                        </div>
                        <button onClick={() => restoreDeletedAssistantThread(thread.id)}>שחזור</button>
                      </article>
                    ))}
                  </div>
                </section>
              )}

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
              <div className="task-editor-meta">
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
                <div className="task-editor-id" aria-label={taskEditor.mode === "create" ? "מספר המשימה יווצר אוטומטית" : `מזהה משימה ${taskEditor.taskId}`}>
                  <span>מזהה</span>
                  <strong>{taskEditor.mode === "create" ? "אוטומטי" : taskEditor.taskId}</strong>
                </div>
              </div>
              <label className="task-title-field">
                <span>שם משימה</span>
                <input {...freeTextInputProps} value={taskEditor.draft.title} onChange={(event) => updateTaskDraft({ title: event.target.value })} placeholder="מה צריך לעשות?" autoFocus />
              </label>
              <div className="edit-grid">
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
                  <input
                    type="date"
                    value={taskEditor.draft.dueDate}
                    min={taskEditor.draft.dueDate && taskEditor.draft.dueDate < todayIso() ? taskEditor.draft.dueDate : todayIso()}
                    onChange={(event) => updateTaskDraft({ dueDate: event.target.value })}
                  />
                </label>
              </div>
              <label className="notes-field">
                <span>הערות</span>
                <textarea {...freeTextInputProps} value={taskEditor.draft.notes} onChange={(event) => updateTaskDraft({ notes: event.target.value })} rows={5} />
              </label>
              <section className="subtasks-editor">
                <div className="subtasks-editor-header">
                  <div>
                    <h3>צעדי טיפול</h3>
                    <p>פירוק פנימי של המשימה לפעולות קטנות. המספור נשמר ברקע ולא מוצג ברשימה.</p>
                  </div>
                  {taskEditor.draft.subtasks.length > 0 && (
                    <div className="subtasks-editor-progress" aria-label="התקדמות צעדי טיפול">
                      <span>{subtaskProgress(taskEditor.draft.subtasks).done}</span>
                      <small>בוצעו מתוך {subtaskProgress(taskEditor.draft.subtasks).total}</small>
                    </div>
                  )}
                  <button type="button" onClick={addDraftSubtask}>הוספת צעד</button>
                </div>
                {taskEditor.draft.subtasks.length === 0 ? (
                  <p className="subtasks-empty">עדיין אין צעדי טיפול למשימה הזו.</p>
                ) : (
                  <div className="subtasks-list">
                    {taskEditor.draft.subtasks.map((subtask) => (
                      <div className={`subtask-row status-${subtask.status}`} key={subtask.number}>
                        <label>
                          <span>צעד טיפול</span>
                          <input
                            {...freeTextInputProps}
                            value={subtask.title}
                            onChange={(event) => updateDraftSubtask(subtask.number, { title: event.target.value })}
                            placeholder="לדוגמה: לתאם פגישה"
                          />
                        </label>
                        <label>
                          <span>פעולה</span>
                          <select
                            value={subtask.actionType ?? ""}
                            onChange={(event) => updateDraftSubtask(subtask.number, { actionType: event.target.value })}
                          >
                            <option value="">ללא פעולה</option>
                            {actionOptions.map((action) => <option value={action} key={action}>{action}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>סטטוס</span>
                          <select
                            value={subtask.status}
                            onChange={(event) => updateDraftSubtask(subtask.number, { status: event.target.value as TaskSubtaskStatus })}
                          >
                            {Object.entries(subtaskStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                          </select>
                        </label>
                        <div className="subtask-row-actions">
                          <button
                            type="button"
                            className="subtask-cancel"
                            onClick={() => cancelDraftSubtask(subtask.number)}
                            disabled={subtask.status === "cancelled"}
                          >
                            ביטול
                          </button>
                          <button
                            type="button"
                            className="subtask-delete"
                            onClick={() => deleteDraftSubtask(subtask.number)}
                            aria-label={subtask.title ? `מחיקת צעד טיפול ${subtask.title}` : "מחיקת צעד טיפול חדש"}
                          >
                            מחיקה
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
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

