/**
 * The strict fake refuses what the 0156/0157 tables refuse, with Postgres's
 * SQLSTATE codes — one case per constraint the loop's writes can hit. If a
 * migration changes a constraint, change `skFakeDb()` and this file together.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/fake-supabase.test.ts
 */
import { describe, expect, it } from "vitest";
import { UUID_RE, uuidv7 } from "../ids";
import { PG_UUID_RE, skFakeDb, typeAccepts } from "./fake-supabase";

const STUDENT = "55555555-0157-0000-0000-000000000001";
const OBJ = "e3eaa67d-5a4f-461a-9a7e-15e6af1e700d";
const ITEM = "71acf08b-bb44-4f23-a34c-018764526476";
const SESSION = uuidv7();

function db() {
  const d = skFakeDb(() => 1_700_000_000_000);
  d.seed("profiles", [{ id: STUDENT }]);
  d.seed("teaching_objectives", [{ id: OBJ }]);
  d.seed("topic_questions", [{ id: ITEM, teaching_objective_id: OBJ, status: "approved" }]);
  d.seed("sk_sessions", [{ id: SESSION, student_id: STUDENT, product_id: "p", chapter: 2, graph_version: 1, status: "open", state: "PAUSED", phase: "TEACH", cursor: {}, bookmarks: [], rate: 1, machine: {}, mastery: {}, history: [], created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" }]);
  return d;
}
const session = (over: Record<string, unknown> = {}) => ({ id: uuidv7(), student_id: STUDENT, product_id: "p", chapter: 2, graph_version: 1, status: "open", state: "PAUSED", phase: "TEACH", cursor: {}, bookmarks: [], rate: 1, machine: {}, mastery: {}, history: [], created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z", ...over });
const attempt = (over: Record<string, unknown> = {}) => ({ event_id: uuidv7(), session_id: SESSION, student_id: STUDENT, item_id: ITEM, teaching_objective_id: OBJ, attempt_no: 1, response: "B", outcome: "correct", score: 1, max_score: 1, independent: true, hint_used: false, hints_used: 0, modality: "typed", transcript_confirmed: true, grader: "deterministic", purpose: "unit", unit_key: "u5", check_key: uuidv7(), check_size: 2, rule_version: "sk-b4.1", at: "2026-10-27T00:00:01Z", ...over });
const code = async (q: PromiseLike<{ error: { code?: string; message: string } | null }>) => (await q).error?.code ?? null;
const message = async (q: PromiseLike<{ error: { code?: string; message: string } | null }>) => (await q).error?.message ?? "";

describe("column types (22P02 / 22007)", () => {
  it("uuid: Postgres's input, not the app's UUID_RE — a version-0 uuid is a valid uuid", () => {
    expect(PG_UUID_RE.test(STUDENT)).toBe(true);
    expect(UUID_RE.test(STUDENT)).toBe(false);
    expect(typeAccepts("uuid", "ch2-u4-c1")).toBe(false);
    expect(typeAccepts("uuid", "student:" + STUDENT)).toBe(false);
    expect(typeAccepts("uuid", STUDENT.replace(/-/g, ""))).toBe(true);
  });
  it("int, numeric, bool, timestamptz, text, jsonb", () => {
    expect([typeAccepts("int", 1), typeAccepts("int", "3"), typeAccepts("int", 1.5), typeAccepts("int", "x")]).toEqual([true, true, false, false]);
    expect([typeAccepts("numeric", 0.85), typeAccepts("numeric", "1"), typeAccepts("numeric", NaN), typeAccepts("numeric", "")]).toEqual([true, true, false, false]);
    expect([typeAccepts("bool", true), typeAccepts("bool", "false"), typeAccepts("bool", "maybe"), typeAccepts("bool", 1)]).toEqual([true, true, false, false]);
    expect([typeAccepts("timestamptz", "2026-10-27T00:00:00.000Z"), typeAccepts("timestamptz", "yesterday"), typeAccepts("timestamptz", 1700000000000)]).toEqual([true, false, false]);
    expect([typeAccepts("text", "x"), typeAccepts("text", 1), typeAccepts("text", { a: 1 })]).toEqual([true, true, false]);
    expect(typeAccepts("jsonb", { any: ["thing"] })).toBe(true);
  });
  it("a payload value the column cannot take: the scope key in sk_events.session_id, a string item id, a non-numeric version", async () => {
    const d = db();
    expect(await code(d.from("sk_events").insert({ session_id: `student:${STUDENT}`, event_id: uuidv7() }))).toBe("22P02");
    expect(await code(d.from("item_attempts").insert(attempt({ item_id: "ch2-u4-c1" })))).toBe("22P02");
    expect(await code(d.from("sk_sessions").insert(session({ graph_version: "three" })))).toBe("22P02");
    expect(await code(d.from("sk_sessions").insert(session({ created_at: "not a time" })))).toBe("22007");
    expect(await code(d.from("sk_sessions").update({ rate: "fast" }).eq("id", SESSION))).toBe("22P02");
  });
  it("a filter value the column cannot take fails the same way: `student_id = 'stu'` is an error, not an empty result", async () => {
    const d = db();
    expect(await code(d.from("sk_sessions").select("*").eq("student_id", "stu"))).toBe("22P02");
    expect(await code(d.from("item_attempts").select("*").eq("session_id", SESSION).eq("item_id", "ch2-u4-c1").maybeSingle())).toBe("22P02");
    expect(await code(d.from("sk_sessions").select("*").in("id", [SESSION, "nope"]))).toBe("22P02");
    expect(await code(d.from("sk_sessions").select("*").eq("student_id", STUDENT))).toBeNull();
  });
});

describe("unknown columns (PGRST204 / 42703) on the strict tables", () => {
  it("a payload column outside the migration is a schema-cache miss; a filter on one does not exist", async () => {
    const d = db();
    expect(await code(d.from("sk_sessions").insert(session({ graphVersion: 1 })))).toBe("PGRST204");
    expect(await message(d.from("sk_sessions").insert(session({ graphVersion: 1 })))).toMatch(/'graphVersion' column of 'sk_sessions'/);
    expect(await code(d.from("item_attempts").select("*").eq("itemId", ITEM))).toBe("42703");
    // the bank's tables are declared loosely (fixtures are partial rows): extra columns pass
    expect(await code(d.from("topic_questions").insert({ id: uuidv7(), stem: "x", teaching_objective_id: OBJ, status: "draft" }))).toBeNull();
  });
});

describe("NOT NULL (23502)", () => {
  it("a missing column with no default, or an explicit null", async () => {
    const d = db();
    const { machine: _m, ...noMachine } = session();
    void _m;
    expect(await code(d.from("sk_sessions").insert(noMachine))).toBe("23502");
    expect(await code(d.from("sk_sessions").insert(session({ state: null })))).toBe("23502");
    // completeEvent(…, undefined) would write result: null — 'null'::jsonb is the DEFAULT, SQL NULL is not allowed
    await d.from("sk_events").insert({ session_id: SESSION, event_id: "0192f5c0-0000-7000-8000-000000000001" });
    expect(await code(d.from("sk_events").update({ status: "stored", kind: "k", result: null, at: "2026-10-27T00:00:01Z" }).eq("session_id", SESSION))).toBe("23502");
    // defaults fill what the payload leaves out
    const ins = await d.from("sk_events").insert({ session_id: SESSION, event_id: "0192f5c0-0000-7000-8000-000000000002" });
    expect(ins.data?.[0]).toMatchObject({ status: "inflight", result: null });
    expect(ins.data?.[0]?.kind ?? null).toBeNull(); // no default, not supplied: NULL (the column is nullable)
    expect(typeof ins.data?.[0]?.claimed_at).toBe("string");
  });
});

describe("CHECK (23514)", () => {
  it("sk_sessions: graph_version >= 1 (live fix #145), chapter >= 1, rate > 0, status, phase", async () => {
    const d = db();
    expect(await message(d.from("sk_sessions").insert(session({ graph_version: 0 })))).toMatch(/sk_sessions_graph_version_check/);
    expect(await message(d.from("sk_sessions").insert(session({ chapter: 0 })))).toMatch(/sk_sessions_chapter_check/);
    expect(await message(d.from("sk_sessions").insert(session({ rate: 0 })))).toMatch(/sk_sessions_rate_check/);
    expect(await message(d.from("sk_sessions").insert(session({ status: "paused" })))).toMatch(/sk_sessions_status_check/);
    expect(await message(d.from("sk_sessions").insert(session({ phase: "LEARN" })))).toMatch(/sk_sessions_phase_check/);
    expect(await code(d.from("sk_sessions").update({ graph_version: 0 }).eq("id", SESSION))).toBe("23514");
  });
  it("sk_events: status, and a stored row needs kind and at", async () => {
    const d = db();
    expect(await code(d.from("sk_events").insert({ session_id: SESSION, event_id: uuidv7(), status: "done" }))).toBe("23514");
    expect(await message(d.from("sk_events").insert({ session_id: SESSION, event_id: uuidv7(), status: "stored", result: { ok: true } }))).toMatch(/sk_events_check/);
    expect(await code(d.from("sk_events").insert({ session_id: SESSION, event_id: uuidv7(), status: "stored", kind: "turn", at: "2026-10-27T00:00:01Z", result: [] }))).toBeNull();
  });
  it("item_attempts: the integrity rules — independent, hint_used ⇔ hints_used, spoken ⇒ confirmed — and the enumerations and bounds", async () => {
    const d = db();
    expect(await message(d.from("item_attempts").insert(attempt({ attempt_no: 2 })))).toMatch(/item_attempts_independent_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ hints_used: 1, hint_used: true })))).toMatch(/item_attempts_independent_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ outcome: "partial", score: 0.5 })))).toMatch(/item_attempts_independent_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ grader: "llm" })))).toMatch(/item_attempts_independent_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ independent: false, hints_used: 1 })))).toMatch(/item_attempts_hint_used_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ modality: "spoken", transcript_confirmed: false })))).toMatch(/item_attempts_transcript_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ outcome: "right" })))).toMatch(/item_attempts_outcome_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ modality: "sung" })))).toMatch(/item_attempts_modality_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ purpose: "exam" })))).toMatch(/item_attempts_purpose_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ attempt_no: 0, independent: false })))).toMatch(/item_attempts_attempt_no_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ check_size: 0 })))).toMatch(/item_attempts_check_size_check/);
    expect(await message(d.from("item_attempts").insert(attempt({ score: -1 })))).toMatch(/item_attempts_score_check/);
    // a NULL passes a column CHECK, as in SQL
    expect(await code(d.from("item_attempts").insert(attempt({ purpose: null, unit_key: null, check_key: null, check_size: null })))).toBeNull();
  });
  it("mastery_state: independent only on mastered; status enumerated", async () => {
    const d = db();
    const row = { student_id: STUDENT, teaching_objective_id: OBJ, status: "provisional", independent: true, evidence: {}, rule_version: "sk-b5.1", updated_at: "2026-10-27T00:00:01Z" };
    expect(await message(d.from("mastery_state").upsert(row, { onConflict: "student_id,teaching_objective_id" }))).toMatch(/mastery_state_independent_check/);
    expect(await message(d.from("mastery_state").upsert({ ...row, status: "done", independent: false }, { onConflict: "student_id,teaching_objective_id" }))).toMatch(/mastery_state_status_check/);
    expect(await code(d.from("mastery_state").upsert({ ...row, status: "mastered" }, { onConflict: "student_id,teaching_objective_id" }))).toBeNull();
    // the upsert's UPDATE path is checked too
    expect(await message(d.from("mastery_state").upsert({ ...row, status: "needs_work", independent: true }, { onConflict: "student_id,teaching_objective_id" }))).toMatch(/mastery_state_independent_check/);
    expect(d.rows("mastery_state")).toHaveLength(1);
  });
});

describe("UNIQUE (23505) and FOREIGN KEY (23503)", () => {
  it("the two replay guards: (session_id, event_id) and (session_id, item_id, attempt_no); one open session per student × product × chapter", async () => {
    const d = db();
    const e = uuidv7();
    expect(await code(d.from("sk_events").insert({ session_id: SESSION, event_id: e }))).toBeNull();
    expect(await code(d.from("sk_events").insert({ session_id: SESSION, event_id: e }))).toBe("23505");
    const a = attempt();
    expect(await code(d.from("item_attempts").insert(a))).toBeNull();
    expect(await code(d.from("item_attempts").insert({ ...a, event_id: uuidv7() }))).toBe("23505");
    expect(await code(d.from("sk_sessions").insert(session()))).toBe("23505"); // the seeded one is open for (STUDENT, p, 2)
    expect(await code(d.from("sk_sessions").insert(session({ status: "closed" })))).toBeNull(); // partial index: closed rows do not collide
  });
  it("every FK the loop's writes cross: student → profiles, session → sk_sessions, item → topic_questions, objective → teaching_objectives", async () => {
    const d = db();
    expect(await message(d.from("sk_sessions").insert(session({ student_id: "55555555-0157-0000-0000-00000000dead", chapter: 3 })))).toMatch(/sk_sessions_student_id_fkey/);
    expect(await message(d.from("sk_events").insert({ session_id: uuidv7(), event_id: uuidv7() }))).toMatch(/sk_events_session_id_fkey/);
    expect(await message(d.from("item_attempts").insert(attempt({ item_id: "00000000-0000-4000-8000-000000000000" })))).toMatch(/item_attempts_item_id_fkey/);
    expect(await message(d.from("item_attempts").insert(attempt({ teaching_objective_id: "00000000-0000-4000-8000-000000000000" })))).toMatch(/item_attempts_teaching_objective_id_fkey/);
    expect(await message(d.from("mastery_state").insert({ student_id: STUDENT, teaching_objective_id: "00000000-0000-4000-8000-000000000000", status: "mastered", rule_version: "x" }))).toMatch(/mastery_state_teaching_objective_id_fkey/);
    // null FK columns are fine (an unmapped item)
    expect(await code(d.from("item_attempts").insert(attempt({ teaching_objective_id: null })))).toBeNull();
  });
  it("Postgres's order: types before NOT NULL before CHECK before UNIQUE before FK", async () => {
    const d = db();
    // same row breaks several rules; the first in Postgres's order is reported
    expect(await code(d.from("item_attempts").insert(attempt({ item_id: "not-a-uuid", outcome: null, attempt_no: 0 })))).toBe("22P02");
    expect(await code(d.from("item_attempts").insert(attempt({ outcome: null, attempt_no: 0 })))).toBe("23502");
    expect(await code(d.from("item_attempts").insert(attempt({ attempt_no: 0, independent: false, item_id: "00000000-0000-4000-8000-000000000000" })))).toBe("23514");
  });
});

describe("the query surface the store uses", () => {
  it("in(): the product filter behind servableGraphs", async () => {
    const d = db();
    d.seed("sk_book_products", [{ id: uuidv7(), slug: "a" }, { id: uuidv7(), slug: "b" }]);
    const { data } = await d.from("sk_book_products").select("slug").in("slug", ["b", "c"]);
    expect(data?.map((r) => r.slug)).toEqual(["b"]);
  });
  it("seed() is the fixture's word: partial rows go in unchecked, writes through the builder are checked", async () => {
    const d = skFakeDb();
    d.seed("sk_sessions", [{ id: "not-even-a-uuid" }]);
    expect(d.rows("sk_sessions")).toHaveLength(1);
    expect(await code(d.from("sk_sessions").insert({ id: "not-even-a-uuid" }))).toBe("22P02");
  });
});
