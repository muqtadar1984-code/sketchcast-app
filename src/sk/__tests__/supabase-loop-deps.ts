// SK — the two production wirings of the teacher loop, side by side, on the
// packaged cells chapter (public/sk-s1/ch02/graph.json) so the same scenario
// runs on both and a contract one wiring keeps and the other breaks fails
// here, not in the founder's browser:
//
//   memoryLoopDeps()    InMemorySessionStore + StaticItemBank — the dev wiring
//                       (`SK_STORE` unset), the static bank loaded with the
//                       same uuid items the database holds, keyed by the
//                       graph's section keys;
//   supabaseLoopDeps()  SupabaseSessionStore + CompositeItemBank(Supabase →
//                       static) over the strict FakeDb (./fake-supabase: the
//                       0156/0157 schema), seeded exactly as production is:
//                       a profiles row for the student, the product, its six
//                       sk_book_units (u-keys with s-section ids), one teaching
//                       objective per unit, and the chapter's topic_questions.
//
// Segments and hit maps are the real packaged files, read through the same
// loaders the routes use.
import { readFileSync } from "node:fs";
import { UUID_RE } from "../ids";
import { CompositeItemBank, StaticItemBank, type ItemBank } from "../items";
import { SupabaseItemBank, toRawQuestion } from "../items-supabase";
import { parseGraph } from "../graph";
import type { LoopDeps } from "../loop";
import { loadHitmapTargetsFromPublic, loadSegmentFromPublic } from "../server";
import { InMemorySessionStore, type SessionStore } from "../store";
import { SupabaseSessionStore } from "../store-supabase";
import type { TeachingGraph } from "../types";
import { FIXTURES, O, PRODUCT, SLUG } from "./cells-fixtures";
import { FakeDb, skFakeDb } from "./fake-supabase";

/** The signed-in student (auth user id = profiles.id), as /api/sk/* passes it. */
export const STUDENT = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5b";

/** sk_book_units for Chapter 2: the exporter's unit keys against the manuscript sections the packager keys the graph by. */
export const UNITS = [
  { unit_key: "u1", section_sid: "s1", title: "Too small to see: why we need a microscope" },
  { unit_key: "u2", section_sid: "s2", title: "Parts of a light microscope" },
  { unit_key: "u3", section_sid: "s3", title: "Using the microscope safely and focusing" },
  { unit_key: "u4", section_sid: "s4", title: "Making a temporary slide" },
  { unit_key: "u5", section_sid: "s5", title: "Magnification and actual size" },
  { unit_key: "u6", section_sid: "s6", title: "Drawing what you see" },
] as const;

/** Item ids by what the scenarios need from them. */
export const ITEM = {
  /** s1 (u1): the two checkable items, in the selector's order (approved, no difficulty → by id). */
  s1_tf: "5788dd4a-a674-49fa-ab1d-e71d8d888c46",
  s1_mcq: "a48f35f1-5a12-44e2-851b-a27d7b7163ff",
  /** s4 (u4): one fill_blank ("coverslip") + one short answer → no check, one practice item. */
  s4_fill: "a5c8ebbe-d00e-4951-81d0-b6fd3d1a55aa",
} as const;

export const GRAPH_URI = "/sk-s1/ch02/graph.json";
export const STANDIN_URI = "/sk-s1/graph-ch2.json";

const readPublic = (uri: string): unknown => JSON.parse(readFileSync(new URL(`../../../public${uri}`, import.meta.url), "utf-8"));
export const cellsGraph = (): TeachingGraph => parseGraph(readPublic(GRAPH_URI), "/sk-s1/ch02/");
export const standinGraph = (): TeachingGraph => parseGraph(readPublic(STANDIN_URI), "/sk-s1/");

/** The static bank's view of the same chapter: the uuid items under the graph's section keys. */
export function cellsStaticBank(): StaticItemBank {
  const items = FIXTURES.map(toRawQuestion).filter((q): q is NonNullable<typeof q> => !!q);
  const byUnit: Record<string, { teachingObjectiveId: string | null; itemIds: string[] }> = {};
  for (const u of UNITS) {
    const objective = O[u.unit_key];
    byUnit[`${SLUG}/2/${u.section_sid}`] = { teachingObjectiveId: objective, itemIds: FIXTURES.filter((f) => f.teaching_objective_id === objective).map((f) => f.id) };
  }
  return new StaticItemBank(items, byUnit);
}

/** A FakeDb seeded as production is for the cells chapter and one student. */
export function cellsDb(now: () => number = () => Date.now()): FakeDb {
  const db = skFakeDb(now);
  db.seed("profiles", [{ id: STUDENT }]);
  db.seed("sk_book_products", [{ id: PRODUCT, slug: SLUG, title: "Cells: structure, function, organisation", status: "approved" }]);
  db.seed(
    "sk_book_units",
    UNITS.map((u, i) => ({ id: `0000000a-0000-4000-8000-00000000000${i + 1}`, product_id: PRODUCT, chapter: 2, unit_key: u.unit_key, section_sid: u.section_sid, title: u.title, sort_order: i })),
  );
  db.seed(
    "teaching_objectives",
    UNITS.map((u) => ({ id: O[u.unit_key], product_id: PRODUCT, chapter: 2, unit_key: u.unit_key, text: u.title, status: "draft" })),
  );
  db.seed("topic_questions", FIXTURES);
  return db;
}

export type LoopHarness = { deps: LoopDeps; store: SessionStore; items: ItemBank; db: FakeDb | null; studentId: string };

const loaders = { loadSegment: loadSegmentFromPublic, loadHitmapElementIds: loadHitmapTargetsFromPublic };

export function memoryLoopDeps(): LoopHarness {
  const store = new InMemorySessionStore();
  const items = cellsStaticBank();
  return { deps: { store, items, graph: cellsGraph(), ...loaders }, store, items, db: null, studentId: STUDENT };
}

/** Exactly `persistence()` in server.ts with `SK_STORE=supabase`, over the fake. */
export function supabaseLoopDeps(opts: { now?: () => number } = {}): LoopHarness & { db: FakeDb; store: SupabaseSessionStore } {
  const now = opts.now ?? (() => Date.now());
  const db = cellsDb(now);
  const store = new SupabaseSessionStore(db, { now, pollMs: 1, inflightTimeoutMs: 500 });
  const items = new CompositeItemBank(new SupabaseItemBank(db), new StaticItemBank(), (id) => UUID_RE.test(id));
  return { deps: { store, items, graph: cellsGraph(), ...loaders }, store, items, db, studentId: STUDENT };
}

/** Both wirings, for `describe.each`. */
export const LOOP_WIRINGS: { name: string; make: () => LoopHarness }[] = [
  { name: "in-memory store + static bank", make: memoryLoopDeps },
  { name: "Supabase store + Supabase bank (strict fake)", make: supabaseLoopDeps },
];
