import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { secretMatches } from "@/utils/lifecycle/token";
import { groupNewGaps } from "@/sk/gaps/group";
import { purgeGapText } from "@/sk/gaps/purge";

export const runtime = "nodejs";
// Never prerender or cache: this has side effects and reads live data.
export const dynamic = "force-dynamic";
// One Haiku call over up to 300 misses, then a few small writes.
export const maxDuration = 300;

// SK gap tracker, nightly (vercel.json: 20:00 UTC, off-peak). Two steps, each
// independent of the other's failure:
//   1. group the oldest `new` misses into themes (src/sk/gaps/group.ts) — one
//      Haiku 5.5 call, skipped entirely when nothing is new;
//   2. clear the text of misses older than SK_GAP_TEXT_DAYS (90) — the rows,
//      their counts and theme links stay.
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; anything else
// is 401, before any database or model call.
async function run(request: Request) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!secretMatches(bearer, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const admin = createAdminClient();
  const group = await groupNewGaps(admin, { now }); // never throws

  let purge: { purged: number; cutoff: string } | null = null;
  let purgeError: string | null = null;
  try {
    purge = await purgeGapText(admin, now);
  } catch (e) {
    purgeError = (e as Error).message.slice(0, 300);
    console.error("sk-gaps.purge failed:", purgeError);
  }

  return NextResponse.json({
    ok: group.status !== "failed" && !purgeError,
    group: {
      status: group.status,
      gaps: group.gaps,
      grouped: group.grouped,
      dismissed: group.dismissed,
      skipped: group.skipped,
      newThemes: group.newThemes,
      reopened: group.reopened,
      usd: group.usage.usd,
      ...(group.error ? { error: group.error } : {}),
    },
    purge: purge ?? { error: purgeError },
  });
}

export const GET = run;
export const POST = run;
