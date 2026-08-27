import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentAllowed } from "@/utils/flags";
import { docDownloadName } from "@/utils/download-name";
import { railFor, pickerFor, type KitGeneration } from "@/utils/present/kit";

export const runtime = "nodejs";

// The kit rail for one part, plus every worksheet in the book that may reach the
// board. The rules live in utils/present/kit.ts; this route fetches and signs.
//
// EIGHT HOURS, NOT ONE. Every other surface in this app signs artifact URLs for
// 3600s, and for a Library page that is right — the link is used within seconds
// of the click. A classroom panel is different: it is woken at 07:00, the board
// is opened once, and Period 6 is at 13:15. A one-hour URL would have expired by
// mid-morning and the video would fail to load in front of a class, with nothing
// on screen to say why. This is the "panel woken early" case the plan flagged,
// and the fix is the TTL rather than a retry.
//
// 404 ON EVERY FAILURE, never 403 — Present mode is unreleased and restricted to
// a named account, and a 403 would advertise that the surface exists.

const SIGN_TTL = 8 * 60 * 60;
const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !presentAllowed(user)) return NOT_FOUND();

  const url = new URL(request.url);
  const bookId = url.searchParams.get("book");
  const chapterRaw = url.searchParams.get("chapter");
  const partRaw = url.searchParams.get("part");
  if (!bookId) return NextResponse.json({ error: "Missing book." }, { status: 400 });
  const chapter = Number(chapterRaw);
  if (!Number.isInteger(chapter)) return NextResponse.json({ error: "Missing chapter." }, { status: 400 });
  const part = partRaw === null || partRaw === "" ? null : Number(partRaw);
  if (part !== null && !Number.isInteger(part))
    return NextResponse.json({ error: "Bad part." }, { status: 400 });

  // Her own generations for this book. RLS already confines this to what she may
  // see; the explicit owner filter keeps a school's shared shelf from filling
  // her rail with a colleague's kits, which would be confusing rather than
  // unsafe.
  const { data: rows, error } = await supabase
    .from("generations")
    .select("id, kind, title, chapter_ref, params, artifacts(kind, storage_path)")
    .eq("book_id", bookId)
    .eq("owner_id", user.id)
    .eq("status", "done")
    .is("withdrawn_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const gens = ((rows ?? []) as unknown as KitGeneration[]).map((g) => ({
    ...g,
    artifacts: g.artifacts ?? [],
  }));

  const rail = railFor(gens, { chapter, part });
  const picker = pickerFor(gens, { chapter, part });

  // Signing needs the service role: the artifacts bucket is not readable through
  // a member session, exactly as the Library does it.
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  const sign = async (path: string | null, download?: string): Promise<string | null> => {
    if (!path || !admin) return null;
    const { data } = await admin.storage
      .from("artifacts")
      .createSignedUrl(path, SIGN_TTL, download ? { download } : undefined);
    return data?.signedUrl ?? null;
  };

  // A chapter can run to several videos (params.video_parts); they are ordered
  // by storage path, which the worker names lesson.mp4, lesson_part2.mp4, …
  const videoPaths = (rail.video?.artifacts ?? [])
    .filter((a) => a.kind === "video_mp4")
    .map((a) => a.storage_path)
    .sort();
  const videos = (await Promise.all(videoPaths.map((p) => sign(p)))).filter(
    (u): u is string => !!u,
  );

  const byId = new Map(gens.map((g) => [g.id, g]));
  const docs = await Promise.all(
    rail.docs.map(async (d) => {
      const g = byId.get(d.id);
      const docPath = g?.artifacts.find((a) => a.kind === "docx")?.storage_path ?? null;
      return {
        ...d,
        title: g?.title ?? null,
        // A download name, so a test paper does not land in Downloads under its
        // storage basename — the same fix docDownloadName exists for.
        download: await sign(docPath, docDownloadName(g?.kind, "docx")),
      };
    }),
  );

  return NextResponse.json({
    video: rail.video ? { id: rail.video.id, title: rail.video.title, urls: videos } : null,
    docs,
    picker,
  });
}
