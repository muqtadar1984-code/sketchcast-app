import { createAdminClient } from "@/utils/supabase/admin";
import { buildIcs, type IcsEvent } from "@/utils/ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The subscribe-by-URL ICS feed: Google/Outlook/Apple poll this endpoint with
// the user's personal token (no session — it's their servers calling). The
// token resolves to a user; calendar_events_for() (SECURITY DEFINER, mirrors
// the se_read RLS) decides exactly what that user may see. Deleting the token
// row kills the URL instantly.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const clean = (token || "").replace(/\.ics$/i, "").trim();
  if (!/^[a-f0-9]{24,64}$/i.test(clean)) return new Response("Not found", { status: 404 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return new Response("Unavailable", { status: 500 });
  }

  const { data: tok } = await admin
    .from("calendar_feed_tokens")
    .select("user_id")
    .eq("token", clean)
    .maybeSingle();
  if (!tok) return new Response("Not found", { status: 404 });

  const { data: events, error } = await admin.rpc("calendar_events_for", { uid: tok.user_id });
  if (error) return new Response("Unavailable", { status: 500 });

  type Row = {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    kind: string;
    starts_at: string;
    ends_at: string | null;
    all_day: boolean;
  };
  const icsEvents: IcsEvent[] = ((events ?? []) as Row[]).map((e) => ({
    uid: `${e.id}@sketchcast.app`,
    title: e.title,
    description: e.description,
    location: e.location,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    allDay: e.all_day,
    category: e.kind,
  }));

  return new Response(buildIcs({ name: "SketchCast — School calendar", events: icsEvents }), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'attachment; filename="sketchcast-school.ics"',
      "cache-control": "private, max-age=300",
    },
  });
}
