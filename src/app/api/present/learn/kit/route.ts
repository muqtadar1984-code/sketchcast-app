import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { signArtifactPath, videoPathsInPartOrder } from "@/utils/present/sign";
import { lessonVideo, loadKitYoutubeIds, topicKitIdOf } from "@/utils/catalogue/kit-youtube";
import { learnerKitFor } from "@/utils/present/learner";
import { learnerGate, loadLearnerKits } from "@/utils/present/learner-server";

export const runtime = "nodejs";

// GET /api/present/learn/kit?kit=<id> — ONE assigned kit, for the student
// Board (learner mode, SK student Board plan 2026-10-31, phase 1).
//
// The same reply /api/present/kit gives a teacher ({units, picker}), so the
// Board consumes it unchanged — built from HER assigned pieces only
// (utils/present/learner.ts) and narrower on purpose:
//   - the lesson video: signed (the stored MP4, else a catalogue copy's
//     YouTube ids), exactly as the teacher's route signs it;
//   - the deck: listed (its pages load through /api/present/deck-pages, which
//     reads a deck assigned to her) — never a .pptx download link;
//   - the worksheets: their questions through /api/quiz/{id}, the
//     answer-STRIPPED paper the student dashboard already uses. The raw
//     questions.json (the marking scheme) and the answer key are never
//     signed here;
//   - nothing else: no lesson plan, no question bank, no test paper, no
//     "elsewhere in the book" picker.
//
// `kit` is the kit's id or the id of ANY of its pieces (My lessons links the
// piece it lists). 404 on every failure, like the teacher's route.

const SIGN_TTL = 8 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NOT_FOUND();
  if (!(await learnerGate(supabase, user)).ok) return NOT_FOUND();

  const kitId = new URL(request.url).searchParams.get("kit") ?? "";
  if (!UUID_RE.test(kitId)) return NextResponse.json({ error: "Missing kit." }, { status: 400 });

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NOT_FOUND();
  }

  const kits = await loadLearnerKits(supabase);
  const kit = learnerKitFor(kits, kitId);
  if (!kit) return NOT_FOUND();

  // The artifact rows of her pieces, as her session read them (re-read here
  // so the signing below uses only paths of pieces the kit proved are hers).
  const { data: rows } = await supabase
    .from("generations")
    .select("id, kind, title, params, artifacts(kind, storage_path)")
    .in("id", kit.members);
  type Row = { id: string; kind: string; title: string | null; params: Record<string, unknown> | null; artifacts: { kind: string; storage_path: string }[] | null };
  const byId = new Map(((rows ?? []) as Row[]).filter((r) => kit.members.includes(r.id)).map((r) => [r.id, { ...r, artifacts: r.artifacts ?? [] }]));

  const sign = (path: string | null): Promise<string | null> => signArtifactPath(admin, path, SIGN_TTL);
  const signedVideos = await Promise.all(
    kit.units.map(async (u) => {
      const vg = u.video ? byId.get(u.video.id) : null;
      return (await Promise.all(videoPathsInPartOrder(vg?.artifacts ?? []).map((p) => sign(p)))).filter((x): x is string => !!x);
    }),
  );
  const kitIds = kit.units
    .map((u, i) => (u.video && !signedVideos[i].length ? topicKitIdOf(byId.get(u.video.id)?.params) : null))
    .filter((x): x is string => !!x);
  const youtubeByKit = await loadKitYoutubeIds(admin, kitIds);

  const units = kit.units.map((u, i) => {
    const vg = u.video ? byId.get(u.video.id) : null;
    const lv = lessonVideo(vg?.params, signedVideos[i], youtubeByKit);
    return {
      part: u.part,
      total: u.total,
      video: u.video ? { id: u.video.id, title: u.video.title, urls: lv.paths, ...(lv.youtube.length ? { youtube: lv.youtube } : {}) } : null,
      docs: u.docs.map((d) => {
        const g = byId.get(d.id);
        const hasQuestions = d.projects && !!g?.artifacts.some((a) => a.kind === "questions_json");
        return {
          ...d,
          title: g?.title ?? null,
          download: null,
          questions: hasQuestions ? `/api/quiz/${d.id}` : null,
        };
      }),
    };
  });

  return NextResponse.json({ units, picker: [] }, { headers: { "Cache-Control": "no-store" } });
}

/** See /api/present/kit: Next's automatic OPTIONS would advertise the route. */
export async function OPTIONS() {
  return NOT_FOUND();
}
