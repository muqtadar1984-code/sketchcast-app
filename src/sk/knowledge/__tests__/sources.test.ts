// SK S7 K2 — sourcesFor: every kind, allowed and refused. Finals only (a draft
// product is never a source, whatever grant points at it); book access by
// purchase / code / edition code / staff grant ONLY — a school licence or a
// subscription opens no book (founder 2026-10-30); a parent's VERIFIED child's grants when acting for that child; every
// approved article as ONE wildcard; uploads exactly as the SESSION (RLS)
// returns them, minus removed and unconfirmed junk-gated books.
// Run: node node_modules/vitest/vitest.mjs run src/sk/knowledge/__tests__/sources.test.ts
import { describe, expect, it } from "vitest";
import { ARTICLE_WILDCARD, rpcSources, sourcesFor, type KnowledgeSourceRef } from "../sources";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";
import { CHILD, CHILD_ID, NOW, OWN_BOOKS, SCHOOL_ID, STRANGER_ID, STUDENT_ID, UNVERIFIED, UNVERIFIED_CHILD_ID, grant, parentCtx, sessionWith, studentCtx, teacherCtx, world } from "./knowledge-world";

const keys = (list: KnowledgeSourceRef[]) => list.map((s) => `${s.kind}:${s.id}${s.version ? `@${s.version}` : ""}`).sort();
const books = (list: KnowledgeSourceRef[]) => keys(list.filter((s) => s.kind === "sketchcast_book"));
/** A grant on EVERY product (finals, the draft, the legacy row): what is listed is then the release rule alone. */
const allGrants = (userId: string, source = "staff") => ["p-bio", "p-bio-ar", "p-chem", "p-alg", "p-legacy"].map((p) => grant(userId, p, { source }));
const deps = (session = sessionWith({ books: [] }), cache?: Map<string, Promise<unknown>>) => ({ session, now: NOW, ...(cache ? { cache } : {}) });

describe("sketchcast_book — finals with book access, never a draft", () => {
  it("a purchase grant opens its final; a revoked grant and a book she never bought do not", async () => {
    const list = await sourcesFor(studentCtx(), world(), deps());
    expect(books(list)).toEqual(["sketchcast_book:cells-structure@12"]);
    expect(list.find((s) => s.kind === "sketchcast_book")).toMatchObject({ title: "Biology", language: "en", product: { id: "p-bio", slug: "biology" }, via: "self" });
  });

  it("a DRAFT product is never a source — not with a code grant, not with a school licence plus a grant on every product", async () => {
    expect(books(await sourcesFor(studentCtx(), world(), deps()))).not.toContain("sketchcast_book:mastering-linear-equations@1");
    const licensed = world({ grants: allGrants(STRANGER_ID), entitlements: [{ school_id: SCHOOL_ID, plan_key: "school_annual", active: true, current_period_end: null }] });
    const list = await sourcesFor(teacherCtx(), licensed, deps());
    expect(books(list)).toEqual(["sketchcast_book:cells-structure@12", "sketchcast_book:cells-structure@13", "sketchcast_book:chem@20"]);
    expect(list.some((s) => s.id === "mastering-linear-equations")).toBe(false);
  });

  it("a product with no live release (legacy, no work) is never a source", async () => {
    expect((await sourcesFor(teacherCtx(), world({ grants: allGrants(STRANGER_ID) }), deps())).some((s) => s.product?.slug === "legacy")).toBe(false);
  });

  it("school licence: opens no book by itself (books are bought) — live, lapsed or another school's", async () => {
    const live = world({ grants: [], entitlements: [{ school_id: SCHOOL_ID, plan_key: "school_annual", active: true, current_period_end: null }] });
    expect(books(await sourcesFor(teacherCtx(), live, deps()))).toEqual([]);
    const lapsed = world({ entitlements: [{ school_id: SCHOOL_ID, plan_key: "school_annual", active: true, current_period_end: new Date(NOW.getTime() - 1000).toISOString() }] });
    expect(books(await sourcesFor(teacherCtx(), lapsed, deps()))).toEqual([]);
    const other = world({ entitlements: [{ school_id: "another-school", plan_key: "school_annual", active: true, current_period_end: null }] });
    expect(books(await sourcesFor(teacherCtx(), other, deps()))).toEqual([]);
  });

  it("subscription: an SK plan alone opens no book; with a grant it opens exactly the granted final, as does any plan", async () => {
    const ctx = makeCtx({ role: "teacher", userId: STRANGER_ID, schoolId: null });
    const sk = { user_id: STRANGER_ID, plan_key: "family_monthly", active: true, current_period_end: null };
    expect(books(await sourcesFor(ctx, world({ entitlements: [sk] }), deps()))).toEqual([]);
    const bought = [grant(STRANGER_ID, "p-chem")];
    expect(books(await sourcesFor(ctx, world({ grants: bought, entitlements: [sk] }), deps()))).toEqual(["sketchcast_book:chem@20"]);
    // the grant decides, not the plan: a plan without SK or an inactive one changes nothing
    const basic = world({ grants: bought, entitlements: [{ user_id: STRANGER_ID, plan_key: "teacher_pro", active: true, current_period_end: null }] });
    expect(books(await sourcesFor(ctx, basic, deps()))).toEqual(["sketchcast_book:chem@20"]);
    const off = world({ entitlements: [{ ...sk, active: false }] });
    expect(books(await sourcesFor(ctx, off, deps()))).toEqual([]);
  });

  it("code, edition code and staff grants count; an expired one and one not yet started do not", async () => {
    const day = 86_400_000;
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    for (const source of ["code", "edition_code", "staff", "promo"]) {
      expect(books(await sourcesFor(studentCtx(), world({ grants: [grant(STUDENT_ID, "p-chem", { source })] }), deps()))).toEqual(["sketchcast_book:chem@20"]);
    }
    expect(books(await sourcesFor(studentCtx(), world({ grants: [grant(STUDENT_ID, "p-chem", { expires_at: at(-day) })] }), deps()))).toEqual([]);
    expect(books(await sourcesFor(studentCtx(), world({ grants: [grant(STUDENT_ID, "p-chem", { activated_at: at(day) })] }), deps()))).toEqual([]);
  });

  it("another user's grant never opens a book for her", async () => {
    expect(books(await sourcesFor(studentCtx(), world({ grants: [grant(CHILD_ID, "p-chem")] }), deps()))).toEqual([]);
  });

  it("0174 not applied (no columns / table): no SketchCast books, the rest still there", async () => {
    const db = world();
    const bad = { ...db, from: (t: string) => (t === "sk_book_products" ? { select: () => ({ eq: () => ({ eq: () => ({ not: () => ({ not: async () => ({ data: null, error: { code: "42703", message: "column work_uid does not exist" } }) }) }) }) }) } : db.from(t)) };
    const list = await sourcesFor(studentCtx(), bad, deps(sessionWith({ books: OWN_BOOKS })));
    expect(books(list)).toEqual([]);
    expect(keys(list)).toContain("article:*");
    expect(keys(list)).toContain("user_book:book-own-ar");
  });

  it("no service client: no SketchCast books (fail closed)", async () => {
    expect(books(await sourcesFor(studentCtx(), null, deps()))).toEqual([]);
  });
});

describe("a parent acting for her child (S4's verified-link rule)", () => {
  it("a VERIFIED child's grant counts when she acts for that child, marked via child", async () => {
    const ctx = parentCtx([CHILD, UNVERIFIED]);
    expect(books(await sourcesFor(ctx, world(), deps()))).toEqual([]);
    const list = await sourcesFor(ctx, world(), deps(), { forChildId: CHILD_ID });
    expect(books(list)).toEqual(["sketchcast_book:chem@20"]);
    expect(list.find((s) => s.id === "chem")?.via).toBe("child");
  });

  it("an UNVERIFIED child, a child who is not hers, or a non-parent naming a child: nothing extra", async () => {
    expect(books(await sourcesFor(parentCtx([CHILD, UNVERIFIED]), world(), deps(), { forChildId: UNVERIFIED_CHILD_ID }))).toEqual([]);
    expect(books(await sourcesFor(parentCtx([UNVERIFIED]), world(), deps(), { forChildId: CHILD_ID }))).toEqual([]);
    expect(books(await sourcesFor(studentCtx(), world(), deps(), { forChildId: CHILD_ID }))).toEqual(["sketchcast_book:cells-structure@12"]);
  });
});

describe("article — every approved article, one wildcard", () => {
  it("any signed-in user gets the wildcard; the RPC is passed {kind: 'article'} with no id", async () => {
    for (const ctx of [studentCtx(), teacherCtx(), parentCtx([])]) {
      const list = await sourcesFor(ctx, world(), deps());
      expect(list.filter((s) => s.kind === "article")).toEqual([{ kind: "article", id: ARTICLE_WILDCARD, language: null, title: "SketchCast articles" }]);
    }
    expect(rpcSources([{ kind: "article", id: ARTICLE_WILDCARD, language: null, title: "" }])).toEqual([{ kind: "article" }]);
    expect(rpcSources([{ kind: "sketchcast_book", id: "w", version: "7", language: "en", title: "" }])).toEqual([{ kind: "sketchcast_book", id: "w", version: "7" }]);
  });

  it("no user id (not signed in): nothing at all", async () => {
    const ctx = studentCtx();
    ctx.user.id = "";
    expect(await sourcesFor(ctx, world(), deps())).toEqual([]);
  });
});

describe("user_book — what RLS shows her, minus removed and unconfirmed junk", () => {
  it("uploads come from the SESSION read (RLS), never from the service role's wider view", async () => {
    const list = await sourcesFor(studentCtx(), world(), deps(sessionWith({ books: OWN_BOOKS })));
    expect(keys(list.filter((s) => s.kind === "user_book"))).toEqual(["user_book:book-own-ar"]);
    expect(list.find((s) => s.id === "book-own-ar")).toMatchObject({ language: "ar", title: "كتابي" });
    expect(list.some((s) => s.id === "book-foreign")).toBe(false); // in the admin's books table, not in her session's
  });

  it("a junk-gated book counts once a teacher confirmed it (a generation stamped params.junk_gate)", async () => {
    const db = world({ generations: [{ id: "g1", book_id: "book-junk-ok", params: { junk_gate: { confirmed_at: "2026-10-01" } } }] });
    const list = await sourcesFor(studentCtx(), db, deps(sessionWith({ books: OWN_BOOKS })));
    expect(keys(list.filter((s) => s.kind === "user_book"))).toEqual(["user_book:book-junk-ok", "user_book:book-own-ar"]);
  });

  it("a failed books read leaves uploads out, nothing else", async () => {
    const broken = { from: () => ({ select: () => ({ is: async () => ({ data: null, error: { message: "boom" } }) }) }), rpc: async () => ({ data: null, error: null }) };
    const list = await sourcesFor(studentCtx(), world(), { session: broken, now: NOW });
    expect(list.some((s) => s.kind === "user_book")).toBe(false);
    expect(books(list)).toEqual(["sketchcast_book:cells-structure@12"]);
  });
});

describe("cached per turn", () => {
  it("one turn's cache reads the sources once; a new turn reads again", async () => {
    const db = world();
    let reads = 0;
    const counting = { ...db, from: (t: string) => (reads++, db.from(t)) };
    const cache = new Map<string, Promise<unknown>>();
    const a = await sourcesFor(studentCtx(), counting, deps(sessionWith({ books: OWN_BOOKS }), cache));
    const first = reads;
    const b = await sourcesFor(studentCtx(), counting, deps(sessionWith({ books: OWN_BOOKS }), cache));
    expect(b).toBe(a);
    expect(reads).toBe(first);
    await sourcesFor(studentCtx(), counting, deps(sessionWith({ books: OWN_BOOKS }), new Map()));
    expect(reads).toBeGreaterThan(first);
  });

  it("the cache key carries the child: acting for a child is a different list", async () => {
    const cache = new Map<string, Promise<unknown>>();
    const ctx = parentCtx([CHILD]);
    expect(books(await sourcesFor(ctx, world(), deps(undefined, cache)))).toEqual([]);
    expect(books(await sourcesFor(ctx, world(), deps(undefined, cache), { forChildId: CHILD_ID }))).toEqual(["sketchcast_book:chem@20"]);
  });
});
