import { handlePersistenceRequest } from "@/lib/server/persistenceTransport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return handlePersistenceRequest(request, "POST"); }
export function GET(request: Request) { return handlePersistenceRequest(request, "GET"); }
