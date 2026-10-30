// SK S7 K2 — one small world for the knowledge tests: four SketchCast
// products (two FINALS of one work in en + ar, a final nobody here bought,
// and a DRAFT), grants of every kind, an article, uploads, and blocks in each.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SkChild, SkContext } from "@/sk/shell/types";
import { makeCtx, SCHOOL_ID, NOW } from "@/sk/shell/__tests__/fixtures";
import { fakeKnowledge, type FakeBlock, type FakeKnowledge } from "./fake-knowledge";

export const STUDENT_ID = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5b";
export const PARENT_ID = "5a5a5a5a-1b1b-4c4c-8d8d-9e9e9e9e9e9e";
export const CHILD_ID = "c1c1c1c1-2d2d-4e4e-8f8f-0a0a0a0a0a0a";
export const UNVERIFIED_CHILD_ID = "c2c2c2c2-2d2d-4e4e-8f8f-0a0a0a0a0a0a";
export const STRANGER_ID = "d3d3d3d3-2d2d-4e4e-8f8f-0a0a0a0a0a0a";

export const ANSWER_KEY = "SECRET-ANSWER-42";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

export const PRODUCTS = [
  { id: "p-bio", slug: "biology", title: "Biology", status: "approved", work_uid: "cells-structure", language: "en", release_id: 12, release_kind: "final" },
  { id: "p-bio-ar", slug: "biology-ar", title: "الأحياء", status: "approved", work_uid: "cells-structure", language: "ar", release_id: 13, release_kind: "final" },
  { id: "p-chem", slug: "chemistry", title: "Chemistry", status: "approved", work_uid: "chem", language: "en", release_id: 20, release_kind: "final" },
  { id: "p-alg", slug: "algebra", title: "Algebra", status: "approved", work_uid: "mastering-linear-equations", language: "en", release_id: 1, release_kind: "draft" },
  { id: "p-legacy", slug: "legacy", title: "Legacy", status: "approved", work_uid: null, language: null, release_id: null, release_kind: null },
];

export const grant = (user_id: string, product_id: string, over: Record<string, unknown> = {}) => ({
  user_id,
  product_id,
  source: "purchase",
  activated_at: iso(-DAY),
  expires_at: null,
  tutor_expires_at: iso(30 * DAY),
  revoked_at: null,
  usage_allowance: null,
  ...over,
});

export const BLOCKS: FakeBlock[] = [
  { source_kind: "sketchcast_book", source_id: "cells-structure", version: "12", chapter: 5, anchor: "s3", title: "Specialised cells", text: "Specialised cells such as red blood cells carry oxygen. Nerve cells carry signals." },
  { source_kind: "sketchcast_book", source_id: "cells-structure", version: "12", chapter: 5, anchor: "x1", title: "Specialised cells", text: "Name two specialised cells.", answer: ANSWER_KEY },
  { source_kind: "sketchcast_book", source_id: "cells-structure", version: "13", chapter: 5, anchor: "s3", title: "الخلايا المتخصصة", text: "الخلايا المتخصصة مثل خلايا الدم الحمراء تنقل الأكسجين." },
  { source_kind: "sketchcast_book", source_id: "chem", version: "20", chapter: 2, anchor: "s1", title: "Cells in batteries", text: "Specialised cells in batteries store chemical energy." },
  { source_kind: "sketchcast_book", source_id: "mastering-linear-equations", version: "1", chapter: 1, anchor: "s1", title: "Draft", text: "DRAFT TEXT about specialised cells that must never be used." },
  { source_kind: "article", source_id: "art-photo-en", version: "3", chapter: null, anchor: "s1", title: "How plants make food", text: "Photosynthesis uses light to make glucose in specialised cells of the leaf." },
  { source_kind: "user_book", source_id: "book-own-ar", version: "h1", chapter: 2, anchor: "p4", title: "التنفس", text: "التنفس الخلوي يطلق الطاقة من الغلوكوز داخل الخلايا." },
  { source_kind: "user_book", source_id: "book-foreign", version: "h2", chapter: 1, anchor: "p1", title: "Foreign", text: "FOREIGN upload text about specialised cells." },
];

export function world(over: { grants?: any[]; entitlements?: any[]; generations?: any[] } = {}): FakeKnowledge {
  return fakeKnowledge(
    {
      sk_book_products: PRODUCTS,
      book_access_grants: over.grants ?? [
        grant(STUDENT_ID, "p-bio"),
        grant(STUDENT_ID, "p-alg", { source: "code" }), // a DRAFT: never a source, grant or not
        grant(STUDENT_ID, "p-chem", { revoked_at: iso(-60_000) }),
        grant(CHILD_ID, "p-chem", { source: "edition_code" }),
        grant(UNVERIFIED_CHILD_ID, "p-bio-ar"),
      ],
      entitlements: over.entitlements ?? [],
      topic_articles: [{ id: "art-photo-en", title: "Photosynthesis", language: "en", status: "approved", version: 3, topic_id: "t1" }],
      generations: over.generations ?? [],
      books: [{ id: "book-foreign", title: "Foreign", language: "en", removed_at: null, health: null }],
    },
    BLOCKS,
  );
}

/** What RLS shows the student's session of `books`. */
export const OWN_BOOKS = [
  { id: "book-own-ar", title: "كتابي", language: "ar", removed_at: null, health: null },
  { id: "book-removed", title: "Old", language: "en", removed_at: "2026-10-01T00:00:00Z", health: null },
  { id: "book-junk", title: "Timetable scan", language: "en", removed_at: null, health: { gate: "confirm" } },
  { id: "book-junk-ok", title: "Confirmed scan", language: "en", removed_at: null, health: { gate: "confirm" } },
];

/** A session client whose `books` read is what RLS would return (no filtering). */
export function sessionWith(tables: Record<string, any[]>) {
  const from = (t: string) => {
    const rows = tables[t] ?? [];
    const b: any = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "gte"]) b[m] = () => b;
    b.maybeSingle = () => b;
    b.then = (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej);
    return b;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

export function studentCtx(over: { locale?: string } = {}): SkContext {
  return makeCtx({ role: "student", hat: null, userId: STUDENT_ID, schoolId: null, plan: "trial", locale: over.locale });
}

export function parentCtx(children: SkChild[]): SkContext {
  return { ...makeCtx({ role: "parent", hat: "parent", userId: PARENT_ID, schoolId: null, plan: "family" }), children };
}

export const CHILD: SkChild = { id: CHILD_ID, firstName: "Aisyah", name: "Aisyah Rahman", source: "self", verified: true, schoolId: null };
export const UNVERIFIED: SkChild = { id: UNVERIFIED_CHILD_ID, firstName: "Omar", name: "Omar Rahman", source: "self", verified: false, schoolId: null };

export function teacherCtx(): SkContext {
  return makeCtx({ role: "teacher", hat: "teacher", userId: STRANGER_ID, schoolId: SCHOOL_ID });
}

export { NOW, SCHOOL_ID };
