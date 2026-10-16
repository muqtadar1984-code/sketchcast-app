// A catalogue document download — the pure decision behind
// GET /api/catalogue/file?gen=…&kind=… (catalogue Phase C, plan §5.2).
//
// WHY A ROUTE. The master files belong to the catalogue system account, under
// ITS storage prefix; the storage policy (artifacts_owner_rw) lets a session
// read only its own prefix, so no teacher's session can sign a master file.
// The service role signs it HERE, after the same access rule the database
// applies everywhere else, for a lifetime measured in minutes. Nothing signed
// is ever rendered into a page (the deck route's lesson, 2026-09-04).
//
// THE RULE, in order — the same order as adopt_catalogue_piece():
//   1. a well-formed request (uuid; a kind this route serves);
//   2. an eligible account — catalogue_ineligible_reason(uid): the release
//      switch, suspension and the role rule, in one place (students are
//      refused here, so the answer key never needs a second role check);
//   3. the generation is a piece of a CURRENT catalogue kit (what the Kits
//      page shows), which also tells us its topic and its generation kind;
//   4. the viewer holds an unlock for that topic;
//   5. the artifact exists.
// A caller who merely knows a generation id learns nothing: an unknown id,
// a non-catalogue id and a locked topic all answer before any path is read.
//
// The store is injected (QuizDb-style) so every branch is testable without a
// database.

import { docDownloadName } from "@/utils/download-name";

type Row = Record<string, unknown>;
type Thenable<T> = PromiseLike<T>;

export type CatalogueStore = {
  rpc(name: string, args?: Record<string, unknown>): Thenable<{ data: unknown; error: unknown }>;
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: unknown): Thenable<{ data: Row[] | null }> & { eq(col: string, v: unknown): Thenable<{ data: Row[] | null }> };
      in(col: string, v: unknown[]): Thenable<{ data: Row[] | null }>;
    };
  };
};

/** The artifact kinds this route serves as DOWNLOADS — the documents of a
 * kit, behind the viewer's unlock. Never questions_json (the marking scheme;
 * the online quiz route owns it), never script_json. Filtering FOR a list, so
 * a kind the worker adds tomorrow is refused by construction. */
export const SERVED_KINDS: ReadonlySet<string> = new Set(["docx", "answer_key_docx", "deck_pptx"]);

/** The kinds served for WATCHING (Kit Translator, plan revision 3 §5.7 —
 * 2026-10-16): the video of a current kit and its thumbnail. The English
 * video is public on YouTube; a translated video has no channel yet (D5) and
 * plays from storage, so these need NO unlock — the lesson is free to watch,
 * as it is on YouTube, and the unlock still gates the documents. */
export const WATCH_KINDS: ReadonlySet<string> = new Set(["video_mp4", "thumbnail_png"]);

/** Ten minutes: minted on the click and followed at once, then it must carry
 * the transfer itself on a school connection. Twice the deck route's five,
 * because a case study with figures is the largest document we write. */
export const CATALOGUE_URL_TTL_SECONDS = 600;

/** Four hours for a video: the player seeks against the SAME signed URL for
 * as long as the tab is open, and a lesson paused over a break must resume. */
export const WATCH_URL_TTL_SECONDS = 4 * 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FileFailure = { ok: false; status: number; error: string };
export type FileResult =
  | { ok: true; path: string; filename: string | undefined; topicId: string; genKind: string; watch: boolean }
  | FileFailure;

const partNum = (path: string): number => {
  const m = /_part(\d+)\.[a-z0-9]+$/i.exec(path);
  return m ? Number(m[1]) : 1;
};

/** Which piece of a kit row a generation is: its generation kind, or null
 * when the row does not hold it. The presentation is keyed by its own column;
 * documents by their kind in doc_generation_ids. */
export function pieceKindIn(
  kit: { presentation_generation_id?: unknown; doc_generation_ids?: unknown },
  generationId: string,
): string | null {
  if (kit.presentation_generation_id === generationId) return "presentation";
  const docs = kit.doc_generation_ids;
  if (docs && typeof docs === "object") {
    // A blank slot (the worker writes "" for a piece that failed its gate) is
    // never a match, whatever the caller passed.
    for (const [kind, id] of Object.entries(docs as Record<string, unknown>))
      if (typeof id === "string" && id && id === generationId) return kind;
  }
  return null;
}

export async function resolveCatalogueFileWith(
  store: CatalogueStore,
  userId: string,
  generationId: string,
  artifactKind: string,
): Promise<FileResult> {
  const watch = WATCH_KINDS.has(artifactKind);
  if (!UUID.test(generationId) || !(SERVED_KINDS.has(artifactKind) || watch)) return { ok: false, status: 404, error: "No such file." };

  const { data: reason, error: reasonError } = await store.rpc("catalogue_ineligible_reason", { uid: userId });
  if (reasonError) return { ok: false, status: 503, error: "Downloads are unavailable right now." };
  if (reason !== null && reason !== undefined) return { ok: false, status: 403, error: "Ready-made kits are not available on this account." };

  const { data: current, error: currentError } = await store.rpc("catalogue_current_kits");
  if (currentError || !Array.isArray(current)) return { ok: false, status: 503, error: "Downloads are unavailable right now." };
  const kitIds = (current as Row[]).map((c) => c.topic_kit_id).filter((id): id is string => typeof id === "string");
  if (kitIds.length === 0) return { ok: false, status: 404, error: "No such file." };

  const { data: kits } = await store.from("topic_kits").select("id, topic_id, presentation_generation_id, doc_generation_ids").in("id", kitIds);
  let topicId: string | null = null;
  let genKind: string | null = null;
  for (const k of kits ?? []) {
    const kind = pieceKindIn(k, generationId);
    if (kind) {
      topicId = k.topic_id as string;
      genKind = kind;
      break;
    }
  }
  if (!topicId || !genKind) return { ok: false, status: 404, error: "No such file." };

  // The video and its frame are watched, not downloaded: no unlock (above);
  // they are only ever the PRESENTATION's, never a document's.
  if (watch && genKind !== "presentation") return { ok: false, status: 404, error: "No such file." };
  if (!watch) {
    const { data: unlocks } = await store.from("catalogue_unlocks").select("id").eq("user_id", userId).eq("topic_id", topicId);
    if (!unlocks || unlocks.length === 0) return { ok: false, status: 403, error: "Unlock this kit first." };
  }

  const { data: arts } = await store.from("artifacts").select("kind, storage_path").eq("generation_id", generationId);
  const paths = (arts ?? [])
    .filter((a) => a.kind === artifactKind)
    .map((a) => a.storage_path)
    .filter((p): p is string => typeof p === "string" && !!p)
    .sort((a, b) => partNum(a) - partNum(b));
  const path = paths[0];
  if (!path) return { ok: false, status: 404, error: "No such file." };

  return { ok: true, path, filename: watch ? undefined : docDownloadName(genKind, artifactKind), topicId, genKind, watch };
}
