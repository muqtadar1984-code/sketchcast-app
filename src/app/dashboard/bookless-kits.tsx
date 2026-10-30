import { fmt } from "@/i18n/format";
import AssignModal, { type ChildRow, type ClassRow } from "./assign-modal";
import DeleteLesson from "./delete-lesson";
import { kindLabel, statusLabel, type LibraryMessages } from "./labels";

// The Library's BOOKLESS generations, categorised (founder, 2026-10-16).
//
// Until now every generation without a book fell into one flat "Other
// lessons" list: a title, a delete cross, and for most rows nothing else —
// no Watch, no download, no Assign. Two very different things land there:
//
//   · COPIES FROM THE CATALOGUE (params.catalogue_ref, migration 0132). A
//     teacher pressed "Add to my Library" on a kit; six rows arrive, one per
//     piece, all sharing a topic. They belong together as ONE kit card with
//     the topic's name, every piece's files, and Assign over the pieces a
//     student may receive.
//   · LESSONS WHOSE BOOK WAS DELETED. generations.book_id is ON DELETE SET
//     NULL, so deleting a book strands its kits here with no chapter list to
//     hang from. They are grouped by the chapter they came from (the title's
//     stem, which the worker writes as "<chapter> · <kind>") under a heading
//     that says what happened.
//
// Pure presentation: the page resolves and signs everything; this only sorts
// and lays out. The per-piece delete is the existing DeleteLesson; AssignModal
// is the Library's own, over the OWNER's rows (which these are — that is the
// whole point of a copy).

/** What this needs from the page's Lesson shape — a structural subset, so the
 * page's inferred type satisfies it without an export. */
export type BooklessLesson = {
  id: string;
  title: string;
  status: string;
  progress: number;
  kind: string;
  params: Record<string, unknown> | null;
  chapterRef: string | null;
  videos: string[];
  decks: string[];
  doc: string | null;
  answerKey: string | null;
};

// A copied online quiz is a `worksheet` GENERATION (its kind), so it sorts
// with the worksheet; its title ("<topic> · Online quiz") tells them apart.
const PIECE_ORDER: readonly string[] = ["presentation", "deck", "lesson_plan", "activity", "worksheet", "exam_paper", "case_study", "exam", "question_bank"];
const rank = (kind: string): number => {
  const i = PIECE_ORDER.indexOf(kind);
  return i === -1 ? PIECE_ORDER.length : i;
};

/** A LIBRARY COPY of system-owned files: a catalogue piece (params.catalogue_ref,
 * 0132) or a SketchCast book chapter's piece (params.product_ref, 0175 — a
 * copy of a catalogue kit too, carrying catalogue_ref as well). Both point at
 * the catalogue account's storage, so the page signs them with the service
 * role, and both group into one ready-made kit card. */
export const isCatalogueCopy = (l: { params: Record<string, unknown> | null }): boolean =>
  !!l.params && typeof l.params === "object" && ("catalogue_ref" in l.params || "product_ref" in l.params);

/** The kit a copy belongs to: its catalogue TOPIC — a SketchCast book's
 * chapter may carry several catalogue kits, and one kit may serve several
 * chapters, so the topic (catalogue_ref, which 0175's copies carry too) is
 * the kit; a copy with only product_ref falls back to its book chapter. */
function copyKey(l: BooklessLesson): string {
  const p = l.params as Record<string, unknown>;
  const ref = p.catalogue_ref as { topic_id?: unknown } | null | undefined;
  if (typeof ref?.topic_id === "string") return ref.topic_id;
  const product = p.product_ref as { product_id?: unknown; chapter_ref?: unknown } | null | undefined;
  if (product && typeof product.product_id === "string") return `product:${product.product_id}:${String(product.chapter_ref ?? "")}`;
  return titleStem(l.title);
}

/** The worker titles every piece "<topic or chapter> · <kind>" (and the
 * presentation "<topic> · <article title>"); the stem before the first
 * separator is the thing the pieces have in common. */
export const titleStem = (title: string): string => title.split(" · ")[0]?.trim() || title;

export type KitGroup = { key: string; title: string; chapterRef: string | null; pieces: BooklessLesson[] };

/** Catalogue copies by topic; stranded lessons by chapter stem. Pieces inside
 * a group in kit order; groups in the order their first piece arrived
 * (the page hands lessons newest-first). */
export function groupBookless(lessons: readonly BooklessLesson[]): { catalogue: KitGroup[]; stranded: KitGroup[] } {
  const catalogue = new Map<string, KitGroup>();
  const stranded = new Map<string, KitGroup>();
  for (const l of lessons) {
    if (isCatalogueCopy(l)) {
      const key = copyKey(l);
      const g = catalogue.get(key) ?? { key, title: titleStem(l.title), chapterRef: null, pieces: [] };
      g.pieces.push(l);
      catalogue.set(key, g);
    } else {
      const stem = titleStem(l.title);
      const key = `${l.chapterRef ?? ""}\u0000${stem}`;
      const g = stranded.get(key) ?? { key, title: stem, chapterRef: l.chapterRef, pieces: [] };
      g.pieces.push(l);
      stranded.set(key, g);
    }
  }
  const finish = (m: Map<string, KitGroup>) =>
    [...m.values()].map((g) => ({ ...g, pieces: [...g.pieces].sort((a, b) => rank(a.kind) - rank(b.kind)) }));
  return { catalogue: finish(catalogue), stranded: finish(stranded) };
}

/** What a student may receive: every finished piece but the teacher's plan
 * and the printable question bank (a teacher's reference, Phase D). */
export const assignableIds = (pieces: readonly BooklessLesson[]): string[] =>
  pieces.filter((p) => p.status === "done" && p.kind !== "lesson_plan" && p.kind !== "question_bank").map((p) => p.id);

// The Library's own status colours (they lived in page.tsx until this section
// became the only place that showed a bookless status).
const STATUS_STYLE: Record<string, string> = {
  queued: "bg-[#EEF0EC] text-[#5B6470]",
  processing: "bg-[#FFF1D6] text-[#9A6400]",
  done: "bg-[#E2F4F1] text-[#0C8175]",
  error: "bg-[#FCEBEA] text-[#B42318]",
};

function KitCard({
  group,
  classes,
  childTargets,
  t,
}: {
  group: KitGroup;
  classes: ClassRow[];
  childTargets: ChildRow[] | null;
  t: LibraryMessages;
}) {
  const assignable = assignableIds(group.pieces);
  return (
    <section className="card p-5" data-kit-group={group.key}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          {group.chapterRef && <p className="text-xs text-[#5B6470]">{fmt(t.chapter, { n: group.chapterRef })}</p>}
          <h3 className="font-display font-medium text-lg leading-snug truncate" title={group.title}>
            {group.title}
          </h3>
        </div>
        {assignable.length > 0 && (
          <div className="shrink-0">
            <AssignModal label={t.assign} generationIds={assignable} classes={classes} childTargets={childTargets} t={t} />
          </div>
        )}
      </div>
      <ul className="divide-y divide-[#E6E8E4]">
        {group.pieces.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-[#1F2A37] w-28 shrink-0">{kindLabel(t, p.kind)}</span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 flex-1 min-w-0">
              {p.status === "done" &&
                p.videos.map((url, i, all) => (
                  <a key={`v${i}`} href={url} target="_blank" className="font-medium text-[#0C8175] hover:underline">
                    ▶ {all.length > 1 ? fmt(t.watchPart, { n: i + 1 }) : t.watch}
                  </a>
                ))}
              {p.status === "done" &&
                p.decks.map((url, i, all) => (
                  <a key={`d${i}`} href={url} className="font-medium text-[#0C8175] hover:underline">
                    ⬇ {all.length > 1 ? fmt(t.deckPart, { n: i + 1 }) : t.deck}
                  </a>
                ))}
              {p.status === "done" && p.doc && (
                <a href={p.doc} className="font-medium text-[#0C8175] hover:underline">
                  ⬇ {t.download}
                </a>
              )}
              {p.status === "done" && p.answerKey && (
                <a href={p.answerKey} className="font-medium text-[#0C8175] hover:underline">
                  ⬇ {t.bookless.answerKey}
                </a>
              )}
              {p.status !== "done" && (
                <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[p.status] ?? ""}`}>
                  {statusLabel(t, p.status)}
                  {p.status === "processing" ? ` · ${p.progress}%` : ""}
                </span>
              )}
            </span>
            <DeleteLesson genId={p.id} status={p.status} t={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function BooklessKits({
  lessons,
  classes,
  childTargets,
  kitsHref,
  t,
}: {
  lessons: readonly BooklessLesson[];
  classes: ClassRow[];
  childTargets: ChildRow[] | null;
  /** The Kits tab, when it is on; null hides the link. */
  kitsHref: string | null;
  t: LibraryMessages;
}) {
  const { catalogue, stranded } = groupBookless(lessons);
  if (catalogue.length === 0 && stranded.length === 0) return null;
  return (
    <>
      {catalogue.length > 0 && (
        <section className="mt-12" data-tour="library-catalogue-kits">
          <h2 className="text-2xl mb-1">{t.bookless.catalogueTitle}</h2>
          <p className="text-sm text-[#5B6470] mb-4">
            {t.bookless.catalogueHint}
            {kitsHref && (
              <>
                {" "}
                <a href={kitsHref} className="font-medium text-[#0C8175] hover:underline">
                  {t.bookless.browseKits}
                </a>
              </>
            )}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {catalogue.map((g) => (
              <KitCard key={g.key} group={g} classes={classes} childTargets={childTargets} t={t} />
            ))}
          </div>
        </section>
      )}
      {stranded.length > 0 && (
        <section className="mt-12" data-tour="library-stranded">
          <h2 className="text-2xl mb-1">{t.bookless.strandedTitle}</h2>
          <p className="text-sm text-[#5B6470] mb-4">{t.bookless.strandedHint}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {stranded.map((g) => (
              <KitCard key={g.key} group={g} classes={classes} childTargets={childTargets} t={t} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
