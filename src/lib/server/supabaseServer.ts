import { createClient, type User } from "@supabase/supabase-js";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
}

export function createSupabaseAdmin() {
  const secret = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret) throw new Error("Missing server environment variable: SUPABASE_SECRET_KEY");
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export class RequestAuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

export async function verifyRequestUser(request: Request): Promise<User> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new RequestAuthError("נדרשת התחברות.");
  const token = authorization.slice("Bearer ".length).trim();
  const client = createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new RequestAuthError("ההתחברות פגה. יש להתחבר מחדש.");
  return data.user;
}
