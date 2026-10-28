/**
 * `context.resolve`: class names ("7B" ≈ "Year 7B"), learners within the
 * user's own classes, books; session-only reads; ownership re-filtered in
 * code so a leaked foreign row never becomes an entity.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/resolve.test.ts
 */
import { describe, expect, it } from "vitest";
import { classNameMatches, cleanQuery, resolveCapability, resolveEntities } from "../resolve";
import { NOW, OTHER_SCHOOL_ID, OTHER_TEACHER_ID, SCHOOL_ID, TEACHER_ID, fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";

const tables = {
  classes: [
    { id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c7a", name: "Year 7A", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "c5am", name: "5 Amanah", teacher_id: TEACHER_ID, school_id: SCHOOL_ID },
    // Leaked rows (the fake ignores .eq) — must never surface.
    { id: "x7b", name: "7B", teacher_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID },
    { id: "y7b", name: "7B", teacher_id: TEACHER_ID, school_id: OTHER_SCHOOL_ID },
  ],
  enrollments: [
    { class_id: "c7b", student_id: "s1", profiles: { full_name: "Ali Hassan", username: "ali" } },
    { class_id: "c7b", student_id: "s2", profiles: { full_name: "Siti Aminah", username: "siti" } },
    { class_id: "x7b", student_id: "s9", profiles: { full_name: "Ali Foreign", username: "alif" } },
  ],
  books: [
    { id: "b1", title: "Science Form 1", owner_id: TEACHER_ID, school_id: SCHOOL_ID },
    { id: "b2", title: "Science Form 2", owner_id: OTHER_TEACHER_ID, school_id: SCHOOL_ID },
    { id: "b3", title: "Science Form 3", owner_id: OTHER_TEACHER_ID, school_id: OTHER_SCHOOL_ID },
  ],
  parent_links: [
    { parent_id: TEACHER_ID, child_id: "k1", profiles: { full_name: "Nur Aisyah", username: "nur" } },
    { parent_id: OTHER_TEACHER_ID, child_id: "k2", profiles: { full_name: "Nur Leak", username: "leak" } },
  ],
};
const deps = (session = fakeSession(tables)) => ({ session, now: NOW });

describe("classNameMatches", () => {
  it.each([
    ["7B", "7B", true],
    ["7B", "7 b", true],
    ["Year 7B", "7B", true],
    ["7B Amanah", "7b", true],
    ["5 Amanah", "5 amanah", true],
    ["5 Amanah", "amanah", true],
    ["17B", "7B", false],
    ["7A", "7B", false],
    ["Year 7B", "7", false],
  ])("%s ~ %s → %s", (name, q, ok) => {
    expect(classNameMatches(name, q)).toBe(ok);
  });
  it("cleanQuery strips ilike wildcards and bounds length", () => {
    expect(cleanQuery("7B%_,()")).toBe("7B");
    expect(cleanQuery("x".repeat(100)).length).toBe(60);
    expect(cleanQuery(42)).toBe("");
  });
});

describe("resolveEntities", () => {
  it("finds the teacher's own class only, never a leaked foreign row", async () => {
    const r = await resolveEntities(makeCtx(), { query: "7B", kind: "class" }, deps());
    expect(r.ok).toBe(true);
    expect(r.entities).toEqual([{ kind: "class", id: "c7b", label: "7B", via: "context.resolve" }]);
    expect(r.facts).toEqual([{ kind: "class", id: "c7b", name: "7B" }]);
  });
  it("reads classes pinned to teacher_id through the session client", async () => {
    const session = fakeSession(tables);
    await resolveEntities(makeCtx(), { query: "7B" }, deps(session));
    expect(session.log).toContain(`classes.eq("teacher_id","${TEACHER_ID}")`);
  });
  it("learners come from the teacher's classes only; carry the class name", async () => {
    const r = await resolveEntities(makeCtx(), { query: "ali", kind: "learner" }, deps());
    expect(r.entities).toEqual([{ kind: "learner", id: "s1", label: "Ali Hassan", via: "context.resolve" }]);
    expect(r.facts).toEqual([{ kind: "learner", id: "s1", name: "Ali Hassan", class: "7B" }]);
  });
  it("books: own or own-school only", async () => {
    const r = await resolveEntities(makeCtx(), { query: "Science", kind: "book" }, deps());
    expect(r.entities!.map((e) => e.id).sort()).toEqual(["b1", "b2"]);
    const noSchool = await resolveEntities(makeCtx({ schoolId: null }), { query: "Science", kind: "book" }, deps());
    expect(noSchool.entities!.map((e) => e.id)).toEqual(["b1"]);
  });
  it("kind any searches everything and summarises", async () => {
    const r = await resolveEntities(makeCtx(), { query: "7B" }, deps());
    expect(r.summary).toMatch(/^Found 1: class "7B" \(c7b\)/);
  });
  it("a parent resolves linked children (own links only), no classes", async () => {
    const session = fakeSession(tables);
    const r = await resolveEntities(makeCtx({ role: "parent", hat: "parent" }), { query: "nur", kind: "learner" }, deps(session));
    expect(r.entities).toEqual([{ kind: "learner", id: "k1", label: "Nur Aisyah", via: "context.resolve" }]);
    expect(session.log.some((l) => l.startsWith("classes."))).toBe(false);
  });
  it("no match → ok with empty facts (so the model says it has nothing)", async () => {
    const r = await resolveEntities(makeCtx(), { query: "9C", kind: "class" }, deps());
    expect(r).toMatchObject({ ok: true, facts: [], entities: [] });
    expect(r.summary).toMatch(/No class matches "9C"/);
  });
  it("empty query → ok:false", async () => {
    expect(await resolveEntities(makeCtx(), { query: "   " }, deps())).toMatchObject({ ok: false, error: "empty_query" });
  });
  it("meta: a read for the adult roles, students excluded", () => {
    expect(resolveCapability.meta).toMatchObject({ name: "context.resolve", tier: "immediate", kind: "read" });
    expect(resolveCapability.meta.roles).not.toContain("student");
  });
});
