import { supabase } from "@/lib/supabase";

export type PersistenceStatus = "committed" | "ok" | "unknown" | "conflict" | "stale_epoch"
  | "idempotency_mismatch" | "restart_required" | "not_found_or_forbidden"
  | "validation_failed" | "account_read_only" | "client_upgrade_required" | "authentication_required";
export type PersistenceCommand = {
  protocolVersion: 1;
  operationId: string;
  kind: "create_task" | "patch_task" | "set_task_status" | "set_owner_focus"
    | "add_subtask" | "patch_subtask" | "remove_subtask" | "set_subtask_status";
  expectedWriteEpoch: string;
  targetTaskUuid?: string;
  expectedRevision?: string;
  patch?: Record<string, unknown>;
  status?: string;
  subtaskId?: string;
  focused?: boolean;
};
export type PersistenceReply = Record<string, unknown> & {
  status: PersistenceStatus;
  operationId?: string;
  requestActorId?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const version = /^[1-9][0-9]*$/;
const REQUEST_TIMEOUT_MS = 15_000;
const statuses = new Set<PersistenceStatus>(["committed", "ok", "unknown", "conflict", "stale_epoch", "idempotency_mismatch",
  "restart_required", "not_found_or_forbidden", "validation_failed", "account_read_only", "client_upgrade_required", "authentication_required"]);
function validSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && uuid.test(task.id)
    && typeof task.revision === "string" && version.test(task.revision)
    && typeof task.writeEpoch === "string" && version.test(task.writeEpoch)
    && ["P", "W"].includes(String(task.prefix)) && Number.isSafeInteger(task.number) && Number(task.number) > 0
    && typeof task.title === "string";
}

async function requestPersistence(expectedUserId: string, query: string, command?: PersistenceCommand): Promise<PersistenceReply> {
  const operationId = command?.operationId ?? new URLSearchParams(query).get("operationId") ?? undefined;
  const unknown = (): PersistenceReply => ({ status: "unknown", ...(operationId ? { operationId } : {}), requestActorId: expectedUserId });
  if (!supabase) return { status: "client_upgrade_required" };
  let serialized: string | undefined;
  if (command) {
    if (!uuid.test(command.operationId)) return { status: "validation_failed", requestActorId: expectedUserId };
    try { serialized = JSON.stringify(command); }
    catch { return { status: "validation_failed", operationId, requestActorId: expectedUserId }; }
    if (new TextEncoder().encode(serialized).byteLength > 65_536) return { status: "validation_failed", operationId, requestActorId: expectedUserId };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session || data.session.user.id !== expectedUserId) {
      return { status: "authentication_required", ...(operationId ? { operationId } : {}), requestActorId: expectedUserId };
    }
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`/api/persistence${query ? `?${query}` : ""}`, {
      method: command ? "POST" : "GET", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...(command ? { "Content-Type": "application/json" } : {}) },
      ...(command ? { body: serialized } : {}),
    });
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return unknown();
    const result = body as PersistenceReply;
    if (!statuses.has(result.status)) return unknown();
    const sameOperation = typeof result.operationId === "string" && uuid.test(result.operationId)
      && result.operationId.toLowerCase() === operationId?.toLowerCase();
    if (operationId && result.operationId && !sameOperation) return unknown();
    if (result.status === "committed") {
      if (!sameOperation || typeof result.revision !== "string" || !version.test(result.revision)
        || typeof result.writeEpoch !== "string" || !version.test(result.writeEpoch) || !response.ok
        || typeof result.targetTaskUuid !== "string" || !uuid.test(result.targetTaskUuid) || !validSnapshot(result.task)
        || (result.task as Record<string, unknown>).id !== result.targetTaskUuid) return unknown();
      if (command?.targetTaskUuid && command.targetTaskUuid.toLowerCase() !== result.targetTaskUuid.toLowerCase()) return unknown();
    }
    if (result.status === "ok" && (!response.ok || !Array.isArray(result.tasks) || !result.tasks.every(validSnapshot)
      || typeof result.complete !== "boolean" || typeof result.changeSeq !== "string" || !/^(0|[1-9][0-9]*)$/.test(result.changeSeq)
      || typeof result.writeEpoch !== "string" || !version.test(result.writeEpoch)
      || (result.complete ? result.cursor !== null : !result.cursor || typeof result.cursor !== "object" || Array.isArray(result.cursor)))) return unknown();
    if (command && result.status === "ok") return unknown();
    return { ...result, ...(operationId ? { operationId } : {}), requestActorId: expectedUserId };
  } catch { return unknown(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

// Caller persists the immutable command before dispatch; no ID generation or automatic replay here.
export function sendPersistenceCommand(command: PersistenceCommand, expectedUserId: string) {
  return requestPersistence(expectedUserId, "", command);
}
export function checkPersistenceOperation(operationId: string, expectedUserId: string) {
  if (!uuid.test(operationId)) return Promise.resolve<PersistenceReply>({ status: "validation_failed", requestActorId: expectedUserId });
  return requestPersistence(expectedUserId, new URLSearchParams({ operationId }).toString());
}
export function fetchPersistencePage(expectedUserId: string, cursor: Record<string, unknown> | null = null, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return Promise.resolve<PersistenceReply>({ status: "validation_failed", requestActorId: expectedUserId });
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", JSON.stringify(cursor));
  return requestPersistence(expectedUserId, query.toString());
}
