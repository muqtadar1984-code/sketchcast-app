import { NextResponse } from "next/server";
import { pollReleases } from "@/sk/knowledge/release";
import type { KnowledgeDb } from "@/sk/knowledge/store";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { founderEmails } from "@/utils/platform-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sk/knowledge/import — the founder's "Import now" (SK S7 K1).
//   → 200 { status: "waiting_for_book_app" }  pub_releases does not exist yet (0172)
//   → 200 { status: "ok", live, imported, unchanged, skipped, unavailable, errors }
// Founder only (FOUNDER_EMAILS, src/utils/platform-admin.ts). Anyone else gets
// 404 so the route is not probeable, the same as the book app's API guard.
// It reads pub_releases and the books bucket and writes only SK tables.

export async function POST() {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!founderEmails().includes((user.email ?? "").toLowerCase())) return NextResponse.json({ error: "Not found." }, { status: 404 });
  try {
    const result = await pollReleases(createAdminClient() as unknown as KnowledgeDb);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[sk knowledge] import now failed:", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
