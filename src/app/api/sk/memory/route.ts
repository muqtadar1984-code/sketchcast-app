import { NextResponse } from "next/server";
import { deleteSkMemory, type MemoryDb } from "@/sk/memory-delete";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/sk/memory            → the caller's own SK memory
// DELETE /api/sk/memory?child=<id> → a VERIFIED linked child's SK memory (parent)
//   → 200 { ok, scope, deleted: { workflowFacts, learningFacts, sessionsCleared, turnsCleared } }
//
// SK S6 slice A (Final Plan §9.5; design decision 7). What goes and what stays
// is in src/sk/memory-delete.ts. Session-gated only: deleting your own memory
// must work whether or not SK is switched on for you (FEATURE_SK,
// SK_ALLOWED_EMAILS), so this route does not run the SK gate().

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: Request) {
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const child = new URL(request.url).searchParams.get("child");
  if (child !== null && !UUID_RE.test(child)) return NextResponse.json({ error: "child must be a child's id." }, { status: 400 });

  const reply = await deleteSkMemory({
    session: session as unknown as MemoryDb,
    admin: () => createAdminClient() as unknown as MemoryDb,
    userId: user.id,
    childId: child ? child.toLowerCase() : null,
  });
  return NextResponse.json(reply.body, { status: reply.status });
}
