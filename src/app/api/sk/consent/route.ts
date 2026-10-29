import { NextResponse } from "next/server";
import type { RpcDb } from "@/sk/consent";
import type { MemoryDb } from "@/sk/memory-delete";
import { consentRequest } from "@/sk/settings";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sk/consent { child, scope: "transcripts" | "voice", grant: boolean }
//   → 200 { ok, consent } | 400 | 403 (not a verified parent of that child)
//
// SK S6 slice C (design decision 2): a VERIFIED linked parent grants or revokes
// SK learning memory (`transcripts`) or voice input (`voice`) for a child. The
// link is checked on the parent's own session first (src/sk/settings.ts
// consentRequest), then the 0173 RPC sk_set_consent checks it again in the
// database as auth.uid() — nothing here can act for another guardian.
// Revoking `transcripts` deletes the child's SK learning memory (the RPC).

export async function POST(request: Request) {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const { data: profile } = await session.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const reply = await consentRequest({
    session: session as unknown as RpcDb & MemoryDb,
    userId: user.id,
    role: (profile?.role as string | null) ?? null,
    body,
  });
  return NextResponse.json(reply.body, { status: reply.status });
}
