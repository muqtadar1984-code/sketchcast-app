import { NextResponse } from "next/server";
import { pollReleases } from "@/sk/knowledge/release";
import type { KnowledgeDb } from "@/sk/knowledge/store";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { skAccessAllowed } from "@/utils/flags";
import { founderEmails } from "@/utils/platform-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sk/knowledge/import — the founder's "Import now" (SK S7 K1).
//   → 200 { status: "waiting_for_book_app" }  pub_releases does not exist
//   → 200 { status: "waiting_for_0174", live }  SK's migration 0174 is not applied
//   → 200 { status: "ok", live, imported, unchanged, skipped, unavailable, errors }
// FINAL releases only (founder 2026-10-30): drafts are logged as skipped.
// Founder only (FOUNDER_EMAILS, src/utils/platform-admin.ts), behind the SK
// allow-list gate like every SK route (skAccessAllowed). Anyone else gets 404
// so the route is not probeable, the same as the book app's API guard.
// It reads pub_releases and the books bucket and writes only SK tables.

export async function POST() {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!(await skAccessAllowed(user))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!founderEmails().includes((user.email ?? "").toLowerCase())) return NextResponse.json({ error: "Not found." }, { status: 404 });
  try {
    const result = await pollReleases(createAdminClient() as unknown as KnowledgeDb);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[sk knowledge] import now failed:", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
