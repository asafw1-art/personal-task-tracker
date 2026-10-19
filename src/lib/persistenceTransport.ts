import { supabase } from "@/lib/supabase";

export type PersistenceStatus = "committed" | "ok" | "prepared" | "context" | "backup" | "unknown" | "conflict" | "stale_epoch"
  | "idempotency_mismatch" | "restart_required" | "not_found_or_forbidden"
  | "validation_failed" | "account_read_only" | "client_upgrade_required" | "authentication_required";
export type PersistenceCommand = {
  protocolVersion: 1;
  operationId: string;
  kind: "create_task" | "patch_task" | "set_task_status" | "set_owner_focus"
    | "add_subtask" | "patch_subtask" | "remove_subtask" | "set_subtask_status"
    | "prepare_ai_proposal" | "apply_ai_proposal" | "invite_share" | "accept_share" | "decline_share"
    | "revoke_share" | "leave_share" | "assign_subtask" | "unassign_subtask" | "set_shared_focus"
    | "save_settings" | "replace_taxonomy" | "rename_taxonomy" | "import";
  expectedWriteEpoch: string;
  targetTaskUuid?: string;
  expectedRevision?: string;
  patch?: Record<string, unknown>;
  status?: string;
  subtaskId?: string;
  focused?: boolean;
  messageId?: string;
  proposalId?: string;
  shareId?: string;
  expectedShareRevision?: string;
  email?: string;
  role?: "viewer" | "contributor";
  expectedDomainRevision?: string;
  taxonomy?: Record<string, unknown>[];
  from?: string;
  to?: string;
  itemType?: "topic" | "action";
  prefix?: "P" | "W";
  items?: Record<string, unknown>[];
};
export type PersistenceReply = Record<string, unknown> & {
  status: PersistenceStatus;
  operationId?: string;
  requestActorId?: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const version = /^[1-9][0-9]*$/;
const REQUEST_TIMEOUT_MS = 15_000;
const statuses = new Set<PersistenceStatus>(["committed", "ok", "prepared", "context", "backup", "unknown", "conflict", "stale_epoch", "idempotency_mismatch",
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
      const domainResult = typeof result.domain === "string" && ["settings", "taxonomy", "import", ...(!command ? ["restore"] : [])].includes(result.domain);
      const endedAccess = !result.task && command && ["leave_share", "decline_share"].includes(command.kind);
      if (domainResult) {
        const expectedDomain = command ? ({ save_settings: "settings", replace_taxonomy: "taxonomy", rename_taxonomy: "taxonomy", import: "import" } as Record<string, string>)[command.kind] : result.domain;
        if (!sameOperation || !response.ok || result.domain !== expectedDomain || typeof result.writeEpoch !== "string" || !version.test(result.writeEpoch)
          || (!["import", "restore"].includes(String(result.domain)) && (typeof result.revision !== "string" || !version.test(result.revision)))
          || (result.domain === "import" && (!Array.isArray(result.items) || !Number.isInteger(result.itemCount) || result.items.length !== result.itemCount))) return unknown();
      } else if (!sameOperation || typeof result.revision !== "string" || !version.test(result.revision)
        || typeof result.writeEpoch !== "string" || !version.test(result.writeEpoch) || !response.ok
        || typeof result.targetTaskUuid !== "string" || !uuid.test(result.targetTaskUuid)
        || (!endedAccess && (!validSnapshot(result.task) || (result.task as Record<string, unknown>).id !== result.targetTaskUuid))) return unknown();
      if (!domainResult && command?.targetTaskUuid && command.targetTaskUuid.toLowerCase() !== String(result.targetTaskUuid).toLowerCase()) return unknown();
    }
    if (result.status === "context" && (command || query !== "context=1" || !response.ok
      || typeof result.writeEpoch !== "string" || !version.test(result.writeEpoch)
      || typeof result.settingsRevision !== "string" || !version.test(result.settingsRevision)
      || typeof result.taxonomyRevision !== "string" || !version.test(result.taxonomyRevision)
      || !Array.isArray(result.sharedTasks) || !result.sharedTasks.every(validSnapshot)
      || !Array.isArray(result.shares) || !Array.isArray(result.taxonomy) || typeof result.sharedComplete !== "boolean")) return unknown();
    if (result.status === "backup") {
      const snapshot = result.snapshot as Record<string, unknown> | undefined;
      if (command || query !== "export=1" || !response.ok || !snapshot || snapshot.version !== 2 || snapshot.owner_user_id !== expectedUserId) return unknown();
    }
    if (result.status === "prepared" && (!sameOperation || !response.ok || command?.kind !== "prepare_ai_proposal"
      || typeof result.proposalId !== "string" || !uuid.test(result.proposalId) || !result.commandPreview
      || typeof result.commandPreview !== "object" || Array.isArray(result.commandPreview))) return unknown();
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
export function fetchPersistenceContext(expectedUserId: string) {
  return requestPersistence(expectedUserId, "context=1");
}
export function fetchPersistenceBackup(expectedUserId: string) { return requestPersistence(expectedUserId, "export=1"); }
export function fetchPersistencePage(expectedUserId: string, cursor: Record<string, unknown> | null = null, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return Promise.resolve<PersistenceReply>({ status: "validation_failed", requestActorId: expectedUserId });
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", JSON.stringify(cursor));
  return requestPersistence(expectedUserId, query.toString());
}
