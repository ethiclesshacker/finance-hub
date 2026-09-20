// healthsync — receives Apple Health batches from the phone.
//
// One route does work: POST /api/apple-health/sync. It checks the request,
// hashes the bearer token, and hands everything to public.health_ingest(),
// which authenticates and writes in a single transaction. See
// supabase/migrations/0009_health.sql for why each of those is the way it is.
//
// There is deliberately no provisioning route, no read route and no CORS. The
// only client is a native app; a browser has no business calling this.
//
// Deploy with --no-verify-jwt: the phone sends its own opaque token, not a
// Supabase JWT, so the gateway's JWT check has to be off and this file is the
// whole of the authentication.
//
//   supabase functions deploy healthsync --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";
import { bearerToken, LIMITS, routePath, ValidationError, validatePayload } from "./validate.js";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads at most `limit` bytes; null if the body is larger. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

Deno.serve(async (req: Request) => {
  const path = routePath(new URL(req.url).pathname);

  if (path === "/health" && req.method === "GET") return json({ ok: true });
  if (path !== "/api/apple-health/sync" || req.method !== "POST") {
    return json({ detail: "Not found" }, 404);
  }

  // The status codes matter: the app retries 5xx and 429 forever, gives up on
  // other 4xx, and asks for a new token on 401/403.
  const token = bearerToken(req.headers.get("authorization"));
  if (!token) return json({ detail: "Missing bearer token" }, 401);

  const body = await readCapped(req, LIMITS.bodyBytes);
  if (body === null) return json({ detail: "Payload too large" }, 413);

  let payload;
  try {
    payload = validatePayload(JSON.parse(body));
  } catch (error) {
    const detail = error instanceof ValidationError ? error.message : "Body is not valid JSON";
    return json({ detail }, 400);
  }

  const { data, error } = await db.rpc("health_ingest", {
    p_token_hash: await sha256Hex(token),
    p_device_id: (req.headers.get("x-device-id") ?? payload.device_id).slice(0, 128),
    p_app_version: (req.headers.get("x-app-version") ?? "").slice(0, 64) || null,
    p_payload: payload,
  });

  if (error) {
    // Code and message only. Postgres error *details* can quote the failing
    // row, and a failing row here is somebody's heart rate.
    console.error("health_ingest failed", error.code, error.message);
    return json({ detail: "Internal server error" }, 500);
  }
  if (!data?.ok) return json({ detail: "Invalid or revoked token" }, 401);

  console.log("ingested", data.export_id, "received", data.received, "deleted", data.deleted);
  return json(data);
});
