import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentEntitled } from "@/utils/present/entitlement";
import { docDownloadName } from "@/utils/download-name";
import { railFor, pickerFor, type KitGeneration } from "@/utils/present/kit";

export const runtime = "nodejs";

// Everything generated for one chapter, plus every worksheet in the book that
// may reach the board. The rules live in utils/present/kit.ts; this route
// fetches and signs.
//
// THE RAIL IS PER CHAPTER, NOT PER PART. A chapter is split into parts at index
// time and every kit is generated per part. A rail scoped to one part would make
// her declare which part she is about to teach before it could show her
// anything; a rail scoped to none matches nothing at all and reads "nothing
// generated yet" while sitting on a full set. She opens the chapter, and the
// rail shows what is there, grouped by unit.
//
// EIGHT HOURS, NOT ONE. Every other surface signs artifact URLs for 3600s, and
// for a Library page that is right — the link is used seconds after the click. A
// classroom panel is woken at 07:00 and Period 6 is at 13:15; a one-hour URL
// would have expired by mid-morning and the video would fail in front of a class
// with nothing on screen to say why.
//
// 404 ON EVERY FAILURE, never 403: a 403 would advertise that the surface exists.

const SIGN_TTL = 8 * 60 * 60;

/** lesson.mp4 is part 1; lesson_part2.mp4, lesson_part3.mp4 follow. */
const videoPart = (path: string): number => {
  const m = /_part(\d+)\.[a-z0-9]+$/i.exec(path);
  return m ? Number(m[1]) : 1;
};
const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NOT_FOUND();

  // Signing needs the service role, and so does the gate: plan_tier is
  // service_role-only. One client, obtained once, used for both — and if it
  // cannot be built there is nothing to sign and nobody to let in.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NOT_FOUND();
  }
  if (!(await presentEntitled(admin, user.id, user)).ok) return NOT_FOUND();

  const url = new URL(request.url);
  const bookId = url.searchParams.get("book");
  const chapterRaw = url.searchParams.get("chapter");
  if (!bookId) return NextResponse.json({ error: "Missing book." }, { status: 400 });
  const chapter = Number(chapterRaw);
  if (!Number.isInteger(chapter)) {
    return NextResponse.json({ error: "Missing chapter." }, { status: 400 });
  }

  // Her own generations for this book. RLS already confines this to what she may
  // see; the explicit owner filter keeps a school's shared shelf from filling her
  // rail with a colleague's kits, which would be confusing rather than unsafe.
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

  const units = railFor(gens, { chapter });
  // The picker is what the RAIL DOES NOT ALREADY SHOW: elsewhere in the book,
  // and the revision papers. The two "here" groups are dropped rather than
  // filtered out of pickerFor itself, because pickerFor's grouping is about
  // where a worksheet sits and stays useful on its own terms.
  const picker = pickerFor(gens, { chapter, part: null }).filter(
    (g) => g.group === "this-book" || g.group === "revision",
  );

  // The artifacts bucket is not readable through a member session, exactly as
  // the Library does it — hence the admin client obtained above.
  const sign = async (path: string | null, download?: string): Promise<string | null> => {
    if (!path) return null;
    const { data } = await admin.storage
      .from("artifacts")
      .createSignedUrl(path, SIGN_TTL, download ? { download } : undefined);
    return data?.signedUrl ?? null;
  };

  const byId = new Map(gens.map((g) => [g.id, g]));

  const out = await Promise.all(
    units.map(async (u) => {
      // A long part can run to several videos (params.video_parts); they are
      // ordered by storage path, which the worker names lesson.mp4,
      // lesson_part2.mp4, and so on.
      const vg = u.video ? byId.get(u.video.id) : null;
      const paths = (vg?.artifacts ?? [])
        .filter((a) => a.kind === "video_mp4")
        .map((a) => a.storage_path)
        // BY EXTRACTED PART NUMBER, never by path string. ICU collation sorts
        // "." AFTER "_", so a plain .sort() puts lesson.mp4 (Part 1) BEHIND
        // lesson_part2.mp4 and the class watches the middle of the lesson
        // first. The dashboard already learned this; this route had the buggy
        // form.
        .sort((a, b) => videoPart(a) - videoPart(b));
      const urls = (await Promise.all(paths.map((pth) => sign(pth)))).filter(
        (x): x is string => !!x,
      );
      const docs = await Promise.all(
        u.docs.map(async (d) => {
          const g = byId.get(d.id);
          const docPath = g?.artifacts.find((a) => a.kind === "docx")?.storage_path ?? null;
          return {
            ...d,
            title: g?.title ?? null,
            // A download name, so a test paper does not land in Downloads under
            // its storage basename — what docDownloadName exists for.
            download: await sign(docPath, docDownloadName(g?.kind, "docx")),
          };
        }),
      );
      return {
        part: u.part,
        total: u.total,
        video: u.video ? { id: u.video.id, title: u.video.title, urls } : null,
        docs,
      };
    }),
  );

  return NextResponse.json({ units: out, picker });
}

/** Taken back explicitly. Next auto-implements OPTIONS when a route file does
 *  not, replying 204 with an `Allow` header to ANY caller, signed in or not —
 *  which tells an unauthenticated prober that this surface exists. The whole
 *  point of answering 404 everywhere else is undone by that one reply. */
export async function OPTIONS() {
  return NOT_FOUND();
}
