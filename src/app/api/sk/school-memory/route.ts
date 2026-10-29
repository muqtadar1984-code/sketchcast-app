import { NextResponse } from "next/server";
import { schoolMemoryRequest, type SettingsDb } from "@/sk/settings";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sk/school-memory { on: boolean } → 200 { ok, on, changedAt }
//
// SK S6 slice C (design decision 2): the principal's switch — "Let SK remember
// learning for students at <school>" — schools.config.sk_learning_memory,
// under the school's data agreement. Mirrors /api/timetable/settings: the
// caller's role and school come from their own profile (school_admin only;
// a coordinator or teacher is refused), the config is MERGED (only this
// switch and who/when change) and written with the service role.

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
  const reply = await schoolMemoryRequest({
    session: session as unknown as SettingsDb,
    admin: () => createAdminClient() as unknown as SettingsDb,
    userId: user.id,
    body,
  });
  return NextResponse.json(reply.body, { status: reply.status });
}
