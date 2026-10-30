// SK S3 slice A — the product → kit read path and its entitlement rule
// (src/sk/product-kits.ts over migration 0170), run against the in-memory
// Supabase fake with the REAL SupabaseEntitlements source.
import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-supabase";
import { SupabaseEntitlements } from "../entitlement";
import { ProductKits, compareChapterRef } from "../product-kits";
import { objectiveKey, parseObjectiveKey } from "../objective-key";

const T0 = Date.parse("2026-10-29T10:00:00Z");
const DAY = 86_400_000;
const PRODUCT = "161828e0-32aa-40df-bbf3-16eb32c82504";
const SLUG = "cells-structure-function-organisation";
const OTHER_PRODUCT = "26f0c1aa-1111-4aaa-8aaa-000000000001";
const STUDENT = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5b";
const STRANGER = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5c";
const SCHOOL_KID = "0f6a2c1e-7b3d-4e5f-8a9b-0c1d2e3f4a5d";
const SCHOOL = "5c5c5c5c-0000-4000-8000-000000000001";

const CELLS = "e064cda5-775d-4b30-a77e-1180123da6a8";
const SPECIALISED = "4885bc51-0e65-4252-bb41-88df6bcc28bc";
const BLOOD = "cbad6d74-7433-46ad-baed-12724c7e59cf";
const RESP = "4246bd3e-48e0-407e-adce-872ab84239bc";
const TRANSPORT = "4160b18e-2c3c-4ed6-b4dd-dce706eb0805";
const INHERIT = "38cf173c-13ac-4860-86df-ce4256c93925";
const UNMAPPED = "9a9a9a9a-0000-4000-8000-000000000009"; // a done presentation, not in the map
const WITHDRAWN = "9a9a9a9a-0000-4000-8000-00000000000a"; // mapped, but withdrawn since
const ELSEWHERE = "9a9a9a9a-0000-4000-8000-00000000000b"; // mapped to ANOTHER product

const gen = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, kind: "presentation", status: "done", withdrawn_at: null, removed_at: null, ...over });
const map = (generation_id: string, chapter_ref: string, sort = 0, product_id = PRODUCT, label: string | null = null) => ({ product_id, chapter_ref, sort, generation_id, label });
const grant = (user_id: string, over: Record<string, unknown> = {}) => ({
  id: `7e3a2f4b-5c6d-4e7f-8a9b-${user_id.slice(-12)}`,
  user_id,
  product_id: PRODUCT,
  source: "staff",
  activated_at: new Date(T0 - DAY).toISOString(),
  expires_at: null,
  tutor_expires_at: new Date(T0 + 365 * DAY).toISOString(),
  revoked_at: null,
  usage_allowance: null,
  ...over,
});

function world() {
  const db = new FakeDb({}, () => T0);
  db.seed("sk_book_products", [
    { id: PRODUCT, slug: SLUG, status: "approved" },
    { id: OTHER_PRODUCT, slug: "another-book", status: "approved" },
  ]);
  // Inserted out of order on purpose: chapter "10"-style text sorting and sort ties are the reader's job.
  db.seed("sk_product_kits", [
    map(INHERIT, "9"),
    map(TRANSPORT, "8", 2),
    map(CELLS, "1", 0, PRODUCT, "Cells"),
    map(RESP, "8", 1),
    map(BLOOD, "8", 0),
    map(SPECIALISED, "5"),
    map(WITHDRAWN, "10"),
    map(ELSEWHERE, "1", 0, OTHER_PRODUCT),
  ]);
  db.seed("generations", [
    gen(CELLS, "Cells · Cells"),
    gen(SPECIALISED, "Specialised Cells · Specialised Cells and Tissues: Structure Fits Function"),
    gen(BLOOD, "Blood and Its Components · Blood and Its Components"),
    gen(RESP, "The Human Respiratory System · The Human Respiratory System"),
    gen(TRANSPORT, "Transport in Plants · Transport in Plants"),
    gen(INHERIT, "Inheritance and Variation · Inheritance and Variation"),
    gen(UNMAPPED, "Not in the book"),
    gen(WITHDRAWN, "Withdrawn kit", { withdrawn_at: new Date(T0 - DAY).toISOString() }),
    gen(ELSEWHERE, "Another book's kit"),
  ]);
  db.seed("profiles", [
    { id: STUDENT, school_id: null },
    { id: STRANGER, school_id: null },
    { id: SCHOOL_KID, school_id: SCHOOL },
  ]);
  db.seed("book_access_grants", [grant(STUDENT)]);
  db.seed("entitlements", [{ school_id: SCHOOL, user_id: null, plan_key: "school_annual", active: true, current_period_end: new Date(T0 + 30 * DAY).toISOString() }]);
  const kits = new ProductKits(db, new SupabaseEntitlements(db), () => new Date(T0));
  return { db, kits };
}

describe("kitsForProduct / kitForChapter", () => {
  it("lists the product's live kits ordered by chapter then sort, by uuid or by slug", async () => {
    const { kits } = world();
    const list = await kits.kitsForProduct(PRODUCT);
    expect(list.map((k) => [k.chapterRef, k.sort, k.generationId.slice(0, 8)])).toEqual([
      ["1", 0, "e064cda5"],
      ["5", 0, "4885bc51"],
      ["8", 0, "cbad6d74"],
      ["8", 1, "4246bd3e"],
      ["8", 2, "4160b18e"],
      ["9", 0, "38cf173c"],
    ]);
    expect(list[0]).toEqual({ chapterRef: "1", sort: 0, generationId: CELLS, label: "Cells", title: "Cells · Cells" });
    expect(list[1].label).toBeNull();
    // the withdrawn kit and the other product's kit are not listed
    expect(list.some((k) => k.generationId === WITHDRAWN || k.generationId === ELSEWHERE)).toBe(false);
    expect(await kits.kitsForProduct(SLUG)).toEqual(list);
    expect(await kits.kitsForProduct("no-such-book")).toEqual([]);
  });

  it("kitForChapter returns the chapter's kits in sort order; a chapter without a kit is empty", async () => {
    const { kits } = world();
    expect((await kits.kitForChapter(PRODUCT, 8)).map((k) => k.generationId)).toEqual([BLOOD, RESP, TRANSPORT]);
    expect((await kits.kitForChapter(SLUG, "5")).map((k) => k.generationId)).toEqual([SPECIALISED]);
    expect(await kits.kitForChapter(PRODUCT, "3")).toEqual([]);
    expect(await kits.kitForChapter(PRODUCT, "10")).toEqual([]); // its only kit was withdrawn
  });

  it("chapter refs order numerically, then as text", () => {
    expect(["10", "2", "1", "b", "a"].sort(compareChapterRef)).toEqual(["1", "2", "10", "a", "b"]);
  });
});

describe("canOpenKit — product entitlement AND the kit is mapped to that product", () => {
  it("an entitled user (staff book grant) opens a mapped kit", async () => {
    const { kits } = world();
    const r = await kits.canOpenKit(STUDENT, PRODUCT, SPECIALISED);
    expect(r).toEqual({
      ok: true,
      product: { id: PRODUCT, slug: SLUG },
      kit: { chapterRef: "5", sort: 0, generationId: SPECIALISED, label: null, title: "Specialised Cells · Specialised Cells and Tissues: Structure Fits Function" },
      grantSource: "staff",
      source: "grant",
    });
    expect((await kits.canOpenKit(STUDENT, SLUG, RESP)).ok).toBe(true);
  });

  it("0175 remap: a master kit of the product's SYSTEM BOOK (book_id set, owned by the catalogue account) opens like a catalogue kit", async () => {
    const { db, kits } = world();
    const MASTER = "9a9a9a9a-0000-4000-8000-0000000000c3";
    db.seed("generations", [
      gen(MASTER, "Cells: Structure — Chapter 3 · Cell Membranes", { book_id: "b0000000-0000-4000-8000-000000000001", owner_id: "0c0c0c0c-0000-4000-8000-00000000000c", chapter_ref: "2" }),
    ]);
    db.seed("sk_product_kits", [map(MASTER, "3", 0, PRODUCT, "Cell Membranes")]);
    const r = await kits.canOpenKit(STUDENT, PRODUCT, MASTER);
    expect(r.ok && r.kit).toEqual({ chapterRef: "3", sort: 0, generationId: MASTER, label: "Cell Membranes", title: "Cells: Structure — Chapter 3 · Cell Membranes" });
    expect((await kits.kitForChapter(PRODUCT, "3")).map((k) => k.generationId)).toEqual([MASTER]);
  });

  it("a school licence alone does not entitle (books are bought); with a purchase grant it opens, source school", async () => {
    const { db, kits } = world();
    expect(await kits.canOpenKit(SCHOOL_KID, PRODUCT, CELLS)).toEqual({ ok: false, reason: "not_entitled" });
    db.seed("book_access_grants", [grant(SCHOOL_KID, { source: "purchase", tutor_expires_at: null })]);
    const r = await kits.canOpenKit(SCHOOL_KID, PRODUCT, CELLS);
    expect(r.ok && r.source).toBe("school"); // the licence still decides tutoring
  });

  it("an unmapped generation is refused even when entitled — as is one mapped to ANOTHER product, a withdrawn one, or a non-uuid", async () => {
    const { kits } = world();
    expect(await kits.canOpenKit(STUDENT, PRODUCT, UNMAPPED)).toEqual({ ok: false, reason: "not_mapped" });
    expect(await kits.canOpenKit(STUDENT, PRODUCT, ELSEWHERE)).toEqual({ ok: false, reason: "not_mapped" });
    expect(await kits.canOpenKit(STUDENT, PRODUCT, WITHDRAWN)).toEqual({ ok: false, reason: "not_mapped" });
    expect(await kits.canOpenKit(STUDENT, PRODUCT, "e064cda5")).toEqual({ ok: false, reason: "not_mapped" });
  });

  it("an unentitled user is refused before the map is read; a revoked or expired grant is no entitlement", async () => {
    const { db, kits } = world();
    expect(await kits.canOpenKit(STRANGER, PRODUCT, CELLS)).toEqual({ ok: false, reason: "not_entitled" });
    db.seed("book_access_grants", [grant(STRANGER, { revoked_at: new Date(T0 - 1000).toISOString() })]);
    expect(await kits.canOpenKit(STRANGER, PRODUCT, CELLS)).toEqual({ ok: false, reason: "not_entitled" });
    const expired = world();
    expired.db.seed("book_access_grants", [grant(STRANGER, { id: "7e3a2f4b-5c6d-4e7f-8a9b-00000000beef", expires_at: new Date(T0 - 1000).toISOString() })]);
    expect(await expired.kits.canOpenKit(STRANGER, PRODUCT, CELLS)).toEqual({ ok: false, reason: "not_entitled" });
    // a grant on ANOTHER product does not open this one's kits
    const other = world();
    other.db.seed("book_access_grants", [grant(STRANGER, { id: "7e3a2f4b-5c6d-4e7f-8a9b-00000000cafe", product_id: OTHER_PRODUCT })]);
    expect(await other.kits.canOpenKit(STRANGER, PRODUCT, CELLS)).toEqual({ ok: false, reason: "not_entitled" });
    expect((await other.kits.canOpenKit(STRANGER, OTHER_PRODUCT, ELSEWHERE)).ok).toBe(true);
  });

  it("an unknown product is refused", async () => {
    const { kits } = world();
    expect(await kits.canOpenKit(STUDENT, "no-such-book", CELLS)).toEqual({ ok: false, reason: "unknown_product" });
    expect(await kits.canOpenKit(STUDENT, "26f0c1aa-1111-4aaa-8aaa-0000000000ff", CELLS)).toEqual({ ok: false, reason: "unknown_product" });
  });
});

describe("objectiveKey", () => {
  const ART = "E5B56E38-90F4-4859-AC89-DEA03821D5AD";
  it('is "<article_id>:<objective_ref>" with the article id lower-cased', () => {
    expect(objectiveKey(ART, "o3")).toBe("e5b56e38-90f4-4859-ac89-dea03821d5ad:o3");
    expect(objectiveKey(" e5b56e38-90f4-4859-ac89-dea03821d5ad ", " o12 ")).toBe("e5b56e38-90f4-4859-ac89-dea03821d5ad:o12");
  });
  it("is null when either part is unusable", () => {
    expect(objectiveKey(null, "o1")).toBeNull();
    expect(objectiveKey(ART, null)).toBeNull();
    expect(objectiveKey("not-a-uuid", "o1")).toBeNull();
    expect(objectiveKey(ART, "")).toBeNull();
    expect(objectiveKey(ART, "o1:o2")).toBeNull();
  });
  it("round-trips through parseObjectiveKey, which rejects anything objectiveKey would not produce", () => {
    const k = objectiveKey(ART, "o3")!;
    expect(parseObjectiveKey(k)).toEqual({ articleId: "e5b56e38-90f4-4859-ac89-dea03821d5ad", objectiveRef: "o3" });
    expect(parseObjectiveKey("o3")).toBeNull();
    expect(parseObjectiveKey(`${ART}:o3`)).toBeNull(); // upper case is not canonical
    expect(parseObjectiveKey(null)).toBeNull();
  });
});
