import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed, skEnabled, skShellEnabledFor } from "@/utils/flags";
import { readManifest } from "@/sk/manifest/store";
import { deriveAndStore } from "@/sk/manifest/service";
import { auditSinkFor, recordSafely } from "@/sk/shell/audit";
import type { SkActionRow } from "@/sk/shell/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// /api/sk/manifest — the Kit Manifest of one presentation (S1 slice A).
//
//   GET  ?generationId=…   the read result: ready (with the manifest) | stale |
//                          building | failed | missing. The Board polls this
//                          while a build runs. Never a stale manifest (store.ts).
//   POST {generationId}    derive on demand (service.ts) and answer with the
//                          read result (the id in the JSON body, or — as a
//                          fallback — in ?generationId=). One sk_actions row per POST
//                          (kind job, tier queued, action manifest.build).
//
// Gate: FEATURE_SK + SK Shell enabled for this user (skShellEnabledFor), signed
// in, and the generation's owner — or PRESENT_ALLOWED_EMAILS staff. The admin
// client (sk_manifests, artifacts, storage) is created only after the gate.
// The manifest carries the kit's narration, so the owner check applies to GET
// as well as POST.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type GateUser = { id: string; email?: string | null; email_confirmed_at?: string | null };
type Gate = { ok: true; user: GateUser; role: string | null; schoolId: string | null } | { ok: false; status: number; error: string };

async function gate(): Promise<Gate> {
  if (!skEnabled()) return { ok: false, status: 404, error: "Not available." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in." };
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) return { ok: false, status: 404, error: "Not available." };
  return { ok: true, user, role, schoolId };
}

type Owned = { ok: true; admin: ReturnType<typeof createAdminClient> } | { ok: false; status: number; error: string };

/** The generation must exist and belong to the caller (or the caller is staff). */
async function ownedGeneration(user: GateUser, generationId: string): Promise<Owned> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, status: 500, error: "Service unavailable." };
  }
  const { data: gen } = await admin.from("generations").select("owner_id").eq("id", generationId).maybeSingle();
  if (!gen) return { ok: false, status: 404, error: "Not found." };
  if ((gen.owner_id as string) !== user.id && !presentAllowed(user)) return { ok: false, status: 403, error: "Not yours." };
  return { ok: true, admin };
}

export async function GET(request: Request) {
  const g = await gate();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
  const generationId = new URL(request.url).searchParams.get("generationId") ?? "";
  if (!UUID_RE.test(generationId)) return NextResponse.json({ error: "generationId is required." }, { status: 400 });
  const o = await ownedGeneration(g.user, generationId);
  if (!o.ok) return NextResponse.json({ error: o.error }, { status: o.status });
  try {
    return NextResponse.json(await readManifest(o.admin, generationId));
  } catch (e) {
    console.error("[sk/manifest] read failed", (e as Error).message);
    return NextResponse.json({ error: "Could not read the manifest." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const started = Date.now();
  const g = await gate();
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  // The body's id; else the query string's (the Board sent only the query
  // until 2026-10-31, and a cached tab may still do so).
  const fromBody = body && typeof body === "object" && typeof (body as { generationId?: unknown }).generationId === "string" ? (body as { generationId: string }).generationId : "";
  const generationId = fromBody || new URL(request.url).searchParams.get("generationId") || "";
  if (!UUID_RE.test(generationId)) return NextResponse.json({ error: "generationId is required." }, { status: 400 });
  const o = await ownedGeneration(g.user, generationId);
  if (!o.ok) return NextResponse.json({ error: o.error }, { status: o.status });

  const result = await deriveAndStore(o.admin, generationId);
  const row: SkActionRow = {
    actor_id: g.user.id,
    school_id: g.schoolId,
    role: g.role,
    hat: null,
    action: "manifest.build",
    tier: "queued",
    kind: "job",
    params: { generationId },
    ok: result.status === "ready" || result.status === "building",
    result: { status: result.status, ...(result.status !== "ready" && result.reason ? { reason: result.reason } : {}) },
    error: result.status === "failed" ? result.reason : undefined,
    session_id: null,
    generation_id: generationId,
    turn_id: null,
    at: new Date(started).toISOString(),
    ms: Date.now() - started,
  };
  await recordSafely(auditSinkFor(o.admin), row);
  const { stats: _stats, ...out } = result; // eslint-disable-line @typescript-eslint/no-unused-vars
  return NextResponse.json(out);
}
