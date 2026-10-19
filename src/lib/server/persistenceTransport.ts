import { createClient } from "@supabase/supabase-js";
import { RequestAuthError, verifyRequestUser } from "@/lib/server/supabaseServer";

const MAX_BODY_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Result = Record<string, unknown> & { status: string };

class InputError extends Error {
  constructor(readonly status: number) { super("Invalid persistence request"); }
}
const headers = { "Cache-Control": "no-store", Vary: "Authorization", "X-Content-Type-Options": "nosniff" };
function reply(result: Result, status: number) { return Response.json(result, { status, headers }); }
function statusCode(result: Result) {
  switch (result.status) {
    case "committed": case "ok": case "prepared": case "context": case "backup": return 200;
    case "unknown": return 202;
    case "conflict": case "stale_epoch": case "idempotency_mismatch": case "restart_required": return 409;
    case "not_found_or_forbidden": return 404;
    case "validation_failed": return 422;
    case "account_read_only": return 423;
    case "client_upgrade_required": return 426;
    default: return 502;
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new InputError(415);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) throw new InputError(413);
  if (!request.body) throw new InputError(400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new InputError(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new InputError(400); }
}

export async function handlePersistenceRequest(request: Request, method: "GET" | "POST") {
  // Closed until the database, all writers, backups and migration gates are ready.
  if (process.env.PERSISTENCE_V1_ENABLED !== "true") return reply({ status: "client_upgrade_required" }, 503);
  let operationId: string | undefined;
  try {
    await verifyRequestUser(request);
    const token = request.headers.get("authorization")!.slice("Bearer ".length).trim();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return reply({ status: "client_upgrade_required" }, 503);
    const client = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    let rpc: string, args: Record<string, unknown>;
    if (method === "POST") {
      const body = await readBoundedJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError(400);
      const value = body as Record<string, unknown>;
      if (typeof value.operationId !== "string" || !UUID.test(value.operationId)) throw new InputError(400);
      operationId = value.operationId;
      rpc = "persistence_command_v1"; args = { p_command: value };
    } else {
      const query = new URL(request.url).searchParams;
      for (const name of query.keys()) if (!["operationId", "cursor", "limit", "context", "export"].includes(name) || query.getAll(name).length !== 1) throw new InputError(400);
      if (query.has("export")) {
        if (query.size !== 1 || query.get("export") !== "1") throw new InputError(400);
        rpc = "persistence_export_self_v1"; args = {};
      } else if (query.has("context")) {
        if (query.size !== 1 || query.get("context") !== "1") throw new InputError(400);
        rpc = "persistence_context_v1"; args = {};
      } else if (query.has("operationId")) {
        if (query.size !== 1 || !UUID.test(query.get("operationId")!)) throw new InputError(400);
        operationId = query.get("operationId")!;
        rpc = "persistence_receipt_v1"; args = { p_operation_id: operationId };
      } else {
        const limit = query.get("limit") ?? "100";
        if (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 200) throw new InputError(400);
        let cursor: unknown = null;
        const rawCursor = query.get("cursor");
        if (rawCursor !== null) {
          if (rawCursor.length > 1024) throw new InputError(400);
          try { cursor = JSON.parse(rawCursor); } catch { throw new InputError(400); }
          if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new InputError(400);
        }
        rpc = "persistence_page_v1"; args = { p_limit: Number(limit), p_cursor: cursor };
      }
    }
    // Supabase/PostgREST responds after the RPC transaction has committed.
    const { data, error } = await client.rpc(rpc, args);
    if (error) return reply({ status: "unknown", ...(operationId ? { operationId } : {}) }, 503);
    if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.status !== "string") {
      return reply({ status: "unknown", ...(operationId ? { operationId } : {}) }, 502);
    }
    const result = data as Result;
    if (statusCode(result) === 502) return reply({ status: "unknown", ...(operationId ? { operationId } : {}) }, 502);
    return reply(result, statusCode(result));
  } catch (error) {
    if (error instanceof RequestAuthError) return reply({ status: "authentication_required" }, error.status);
    if (error instanceof InputError) return reply({ status: "validation_failed" }, error.status);
    // A connection error after dispatch cannot prove that the write was rolled back.
    return reply({ status: "unknown", ...(operationId ? { operationId } : {}) }, 503);
  }
}
