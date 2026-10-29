import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentEntitled } from "@/utils/present/entitlement";
import { PAGE_H, PAGE_W } from "@/board/model";
import { parseDeckMap, type DeckMap } from "@/app/present/deck-text";
import {
  DECK_PAGES_JOB,
  isDeckSource,
  mapPathOf,
  slideFiles,
  type ArtifactRow,
  type DeckPagesReply,
  type DeckSlideRef,
} from "@/utils/present/deck-pages";

export const runtime = "nodejs";

// The kit's .pptx on the Classroom Board, one slide per page (founder,
// 2026-10-28). The worker renders the deck (job `deck_pages`, an observer job
// that never rebuilds it); this route reports whether the pages are there,
// signs them, and asks for them.
//
//   GET  ?generationId=  → {status: "ready", slides, mapUrl, map}
//                          | {status: "building"} (a deck_pages job is queued/processing)
//                          | {status: "missing"}
//   POST {generationId}  → enqueue the render (idempotent) → {status: "building"};
//                          a deck already rendered answers as GET does.
//
// HER OWN DECK ONLY. The generation is read through HER session with an
// explicit owner filter, exactly as the kit rail reads it, and every later
// step — the job row, the signatures — uses the id that read returned. A deck
// that is not hers is a 404, and no job is ever queued for it: `jobs` is
// service-role only, so this route is the whole of the check.
//
// Same gate and the same 8-hour signatures as /api/present/kit, and 404 on
// every failure (a 403 would advertise the surface).

const SIGN_TTL = 8 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = () => NextResponse.json({ error: "Not found." }, { status: 404 });

type Admin = ReturnType<typeof createAdminClient>;
type Gen = { id: string; kind: string; owner_id: string; artifacts: ArtifactRow[] };

async function gate(): Promise<{ supabase: Awaited<ReturnType<typeof createClient>>; admin: Admin; userId: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  let admin: Admin;
  try {
    admin = createAdminClient();
  } catch {
    return null;
  }
  if (!(await presentEntitled(admin, user.id, user)).ok) return null;
  return { supabase, admin, userId: user.id };
}

/** Her own done deck (or deck-carrying presentation), or null. */
async function ownedDeck(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, id: string): Promise<Gen | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await supabase
    .from("generations")
    .select("id, kind, owner_id, artifacts(kind, storage_path)")
    .eq("id", id)
    .eq("owner_id", userId)
    .eq("status", "done")
    .is("withdrawn_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const g = data as unknown as Gen;
  const gen = { ...g, artifacts: g.artifacts ?? [] };
  // Belt and braces: the filter above already said so.
  if (gen.owner_id !== userId || !isDeckSource(gen)) return null;
  return gen;
}

/** Is a render for this deck already waiting or running? */
async function activeJob(admin: Admin, generationId: string): Promise<boolean | null> {
  const { data, error } = await admin
    .from("jobs")
    .select("id, status")
    .eq("type", DECK_PAGES_JOB)
    .in("status", ["queued", "processing"])
    .eq("params->>generation_id", generationId)
    .limit(1);
  if (error) return null;
  return Array.isArray(data) && data.length > 0;
}

/** The ready reply, or null when no slide has been rendered yet. */
async function readyReply(admin: Admin, gen: Gen): Promise<DeckPagesReply | null> {
  const files = slideFiles(gen.artifacts);
  if (!files.length) return null;
  const bucket = admin.storage.from("artifacts");
  const sign = async (path: string): Promise<string | null> => {
    const { data } = await bucket.createSignedUrl(path, SIGN_TTL);
    return data?.signedUrl ?? null;
  };

  // The text map: by its row when 0166 is applied, else BY ITS PATH beside the
  // slides. Downloaded here for each slide's size and title; a map that is not
  // there (or not a map) costs the titles, never the pages.
  const where = mapPathOf(gen.artifacts, files, gen);
  let map: DeckMap | null = null;
  const dl = await bucket.download(where.path);
  if (!dl.error && dl.data) {
    try {
      map = parseDeckMap(JSON.parse(await dl.data.text()));
    } catch {
      map = null;
    }
  }
  const mapUrl = map ? await sign(where.path) : null;

  const slides: DeckSlideRef[] = await Promise.all(
    files.map(async (f) => {
      const e = map?.slides.find((s) => s.n === f.n);
      return { n: f.n, path: f.path, url: await sign(f.path), w: e?.w ?? PAGE_W, h: e?.h ?? PAGE_H, title: e?.title ?? "" };
    }),
  );
  return { status: "ready", slides, mapUrl, map: map ? where.path : null };
}

export async function GET(request: Request) {
  const g = await gate();
  if (!g) return NOT_FOUND();
  const id = new URL(request.url).searchParams.get("generationId") ?? "";
  const gen = await ownedDeck(g.supabase, g.userId, id);
  if (!gen) return NOT_FOUND();

  const ready = await readyReply(g.admin, gen);
  if (ready) return NextResponse.json(ready);
  const active = await activeJob(g.admin, gen.id);
  if (active === null) return NextResponse.json({ error: "Could not read the job queue." }, { status: 500 });
  const reply: DeckPagesReply = { status: active ? "building" : "missing" };
  return NextResponse.json(reply);
}

export async function POST(request: Request) {
  const g = await gate();
  if (!g) return NOT_FOUND();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const id = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).generationId : null;
  if (typeof id !== "string") return NextResponse.json({ error: "Missing generationId." }, { status: 400 });
  const gen = await ownedDeck(g.supabase, g.userId, id);
  if (!gen) return NOT_FOUND();

  // Already rendered: nothing to ask for.
  const ready = await readyReply(g.admin, gen);
  if (ready) return NextResponse.json(ready);

  // IDEMPOTENT: one live render per deck. Two clicks a second apart can both
  // pass this check; the worker's render is a pure function of the deck and
  // overwrites its own files, so the second job costs a render, never a mess.
  const active = await activeJob(g.admin, gen.id);
  if (active === null) return NextResponse.json({ error: "Could not read the job queue." }, { status: 500 });
  if (!active) {
    const { error } = await g.admin
      .from("jobs")
      .insert({ type: DECK_PAGES_JOB, status: "queued", generation_id: null, params: { generation_id: gen.id } });
    if (error) return NextResponse.json({ error: "Could not queue the deck." }, { status: 500 });
  }
  const reply: DeckPagesReply = { status: "building" };
  return NextResponse.json(reply);
}

/** See /api/present/kit: Next's automatic OPTIONS would advertise the route. */
export async function OPTIONS() {
  return NOT_FOUND();
}
