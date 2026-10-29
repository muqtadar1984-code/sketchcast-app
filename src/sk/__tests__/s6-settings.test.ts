// SK S6 slice C — the "SK & privacy" settings: the preferences (and their
// one-time migration from localStorage), the page's data per role, the
// consent request (a verified parent only), the principal's school switch
// (own school only; a coordinator refused), and workflow facts in use.
// Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/s6-settings.test.ts

import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, parseLocalFlag, prefsFromFacts, resolvePrefs, withDefaults } from "../prefs";
import { consentRequest, describeLearning, describeWorkflow, loadSkSettings, savePrefs, schoolMemoryRequest } from "../settings";
import { boardLink, pendingToSave, recordWorkflow, workflowFromTurn } from "../shell/workflow";
import { freshMemory, sealMemory, verifyMemory, type SkMemory } from "../shell/memory";
import { makeCtx } from "../shell/__tests__/fixtures";
import { CHILD, OTHER_PARENT, PARENT, S6Db, s6World, SCHOOL, SCHOOL_CHILD, TEACHER, UNLINKED_CHILD } from "./s6-fake-db";

const NOW = new Date("2026-10-29T02:00:00Z");
const PRINCIPAL = "88888888-8888-4888-8888-888888888888";
const COORDINATOR = "99999999-9999-4999-8999-999999999999";
const OTHER_SCHOOL = "abababab-abab-4bab-8bab-abababababab";

const fact = (owner: string, kind: string, key: string, value: unknown, updated = "2026-10-28T00:00:00Z") => ({ owner_id: owner, kind, key, value, updated_at: updated, expires_at: "2027-10-28T00:00:00Z" });

// ── the preferences ─────────────────────────────────────────────────────────

describe("preferences: stored as workflow facts, migrated once from localStorage (pure)", () => {
  it("defaults: read aloud on, hands-free off, suggestions ON", () => {
    expect(DEFAULT_PREFS).toEqual({ readAloud: true, handsFree: false, suggestions: true });
    expect(withDefaults(null)).toEqual(DEFAULT_PREFS);
  });

  it("prefsFromFacts reads only well-formed preference facts", () => {
    expect(
      prefsFromFacts([
        { kind: "preference", key: "read_aloud", value: { on: false } },
        { kind: "preference", key: "hands_free", value: { on: "yes" } },
        { kind: "preference", key: "nonsense", value: { on: true } },
        { kind: "recent_class", key: "suggestions", value: { on: false } },
        { kind: "preference", key: "suggestions", value: { on: false } },
      ]),
    ).toEqual({ readAloud: false, suggestions: false });
  });

  it("parseLocalFlag: 'on' / 'off' only", () => {
    expect([parseLocalFlag("on"), parseLocalFlag("off"), parseLocalFlag(null), parseLocalFlag("true")]).toEqual([true, false, undefined, undefined]);
  });

  it("first visit on a new server: the browser's values win and are migrated", () => {
    expect(resolvePrefs({}, { readAloud: false, handsFree: true }, false)).toEqual({
      prefs: { readAloud: false, handsFree: true, suggestions: true },
      migrate: { readAloud: false, handsFree: true },
    });
  });

  it("the server's stored value wins over the browser's; nothing is migrated over it", () => {
    expect(resolvePrefs({ readAloud: true }, { readAloud: false, handsFree: true }, false)).toEqual({
      prefs: { readAloud: true, handsFree: true, suggestions: true },
      migrate: { handsFree: true },
    });
  });

  it("already migrated in this browser and absent on the server (memory deleted) → the default, not the stale copy", () => {
    expect(resolvePrefs({}, { readAloud: false }, true)).toEqual({ prefs: DEFAULT_PREFS, migrate: {} });
  });

  it("the server unreadable → keep the browser's values, migrate NOTHING", () => {
    expect(resolvePrefs(null, { handsFree: true }, false)).toEqual({ prefs: { ...DEFAULT_PREFS, handsFree: true }, migrate: {} });
  });

  it("savePrefs writes one preference fact per key on the owner's session; junk is refused", async () => {
    const db = s6World();
    expect(await savePrefs(db, TEACHER, { suggestions: false, readAloud: true, other: 1 }, NOW)).toEqual({ status: 200, body: { ok: true, saved: { readAloud: true, suggestions: false } } });
    expect(db.rows("sk_workflow_facts").map((r) => [r.owner_id, r.kind, r.key, r.value])).toEqual([
      [TEACHER, "preference", "read_aloud", { on: true }],
      [TEACHER, "preference", "suggestions", { on: false }],
    ]);
    expect((await savePrefs(db, TEACHER, { suggestions: "no" }, NOW)).status).toBe(400);
    db.fail.add("sk_workflow_facts");
    expect((await savePrefs(db, TEACHER, { suggestions: true }, NOW)).status).toBe(500);
  });
});

// ── the page's data ─────────────────────────────────────────────────────────

function world(): S6Db {
  const db = s6World();
  db.rows("profiles").push({ id: PRINCIPAL, role: "school_admin", school_id: SCHOOL, full_name: "Puan Aminah" }, { id: COORDINATOR, role: "coordinator", school_id: SCHOOL });
  Object.assign(db.rows("profiles").find((p) => p.id === CHILD)!, { full_name: "Adam Lee" });
  db.rows("schools")[0]!.name = "SK Taman Ilmu";
  return db;
}

describe("loadSkSettings — the page's sections by role", () => {
  it("everyone: the preferences and what SK remembers, in plain words", async () => {
    const db = world();
    db.rows("sk_workflow_facts").push(
      fact(TEACHER, "preference", "suggestions", { on: false }),
      fact(TEACHER, "recent_class", "c1", { label: "5B" }),
      fact(TEACHER, "recent_kit", "kit:g1", { label: "Plant and Animal Cells", classLabel: "5B" }),
      fact(PARENT, "recent_class", "c2", { label: "NOT MINE" }),
    );
    const d = await loadSkSettings({ session: db, admin: db, userId: TEACHER, role: "teacher", schoolId: SCHOOL, now: NOW });
    expect(d.prefs).toEqual({ readAloud: true, handsFree: false, suggestions: false });
    expect(d.memoryReadable).toBe(true);
    expect(d.workflow.map((r) => ("label" in r ? r.label : `${r.pref}=${r.on}`)).sort()).toEqual(["5B", "5B, Plant and Animal Cells", "suggestions=false"]);
    expect(d.learning).toBeNull();
    expect(d.children).toEqual([]);
    expect(d.school).toBeNull();
    expect(d.student).toBeNull();
  });

  it("the fact stores unreadable (0173 not applied) → memoryReadable false, defaults, no throw", async () => {
    const db = world();
    db.fail.add("sk_workflow_facts");
    const d = await loadSkSettings({ session: db, admin: db, userId: TEACHER, role: "teacher", schoolId: SCHOOL, now: NOW });
    expect(d.memoryReadable).toBe(false);
    expect(d.prefs).toEqual(DEFAULT_PREFS);
  });

  it("a parent: VERIFIED children only, with the parent's own consent per scope", async () => {
    const db = world();
    db.rows("parent_links").push({ parent_id: PARENT, child_id: UNLINKED_CHILD, verified_at: null });
    db.rows("consents").push(
      { child_id: CHILD, guardian_id: PARENT, scope: "transcripts", revoked_at: null },
      { child_id: CHILD, guardian_id: PARENT, scope: "voice", revoked_at: "2026-10-20T00:00:00Z" },
      { child_id: CHILD, guardian_id: OTHER_PARENT, scope: "voice", revoked_at: null },
    );
    const d = await loadSkSettings({ session: db, admin: db, userId: PARENT, role: "parent", schoolId: null, now: NOW });
    expect(d.children).toEqual([{ id: CHILD, name: "Adam Lee", transcripts: true, voice: false }]);
  });

  it("a principal: the school switch with who changed it and when", async () => {
    const db = world();
    db.rows("schools")[0]!.config = { sk_learning_memory: true, sk_learning_memory_changed: { by: PRINCIPAL, at: "2026-10-28T09:00:00Z" } };
    const d = await loadSkSettings({ session: db, admin: db, userId: PRINCIPAL, role: "school_admin", schoolId: SCHOOL, now: NOW });
    expect(d.school).toEqual({ id: SCHOOL, name: "SK Taman Ilmu", on: true, changedBy: "Puan Aminah", changedAt: "2026-10-28T09:00:00Z" });
    // a coordinator sees no switch
    expect((await loadSkSettings({ session: db, admin: db, userId: COORDINATOR, role: "coordinator", schoolId: SCHOOL, now: NOW })).school).toBeNull();
  });

  it("a student: their learning facts, and who turned memory on (parent / school / nobody)", async () => {
    const db = world();
    db.rows("sk_learning_facts").push({ id: "f1", student_id: CHILD, kind: "misconception", objective_key: "a:1", detail: { misconception: "Plant cells have no mitochondria" }, source: "sk.kit.remediation", created_at: "2026-10-27T00:00:00Z", expires_at: "2027-01-25T00:00:00Z" });
    let d = await loadSkSettings({ session: db, admin: db, userId: CHILD, role: "student", schoolId: null, now: NOW });
    expect(d.student).toEqual({ memory: null, voice: null });
    expect(d.learning).toEqual([{ kind: "misconception", label: "Plant cells have no mitochondria", date: "2026-10-27T00:00:00Z", until: "2027-01-25T00:00:00Z" }]);
    db.rows("consents").push({ child_id: CHILD, guardian_id: PARENT, scope: "transcripts", revoked_at: null });
    d = await loadSkSettings({ session: db, admin: db, userId: CHILD, role: "student", schoolId: null, now: NOW });
    expect(d.student).toEqual({ memory: "parent", voice: null });
    const sw = s6World({ switchOn: true });
    d = await loadSkSettings({ session: sw, admin: sw, userId: SCHOOL_CHILD, role: "student", schoolId: SCHOOL, now: NOW });
    expect(d.student?.memory).toBe("school");
    // and a student is never shown a children or school section
    expect(d.children).toEqual([]);
    expect(d.school).toBeNull();
  });

  it("describeWorkflow / describeLearning are plain words, never raw JSON", () => {
    expect(describeWorkflow([{ kind: "pending_task", key: "notice.post", value: { task: "notice.post" }, updatedAt: null, expiresAt: null }])).toEqual([{ kind: "pending_task", label: "notice.post", date: null }]);
    expect(describeLearning([{ id: "x", kind: "explained", objectiveKey: "a:2", detail: { heading: "Osmosis" }, source: "s", createdAt: null, expiresAt: null }])[0]!.label).toBe("Osmosis");
  });
});

// ── POST /api/sk/consent ────────────────────────────────────────────────────

function rpcWorld() {
  const db = world();
  db.rpcs.sk_set_consent = (a) => ({ data: { child_id: a.p_child, scope: a.p_scope, granted_at: "2026-10-29T02:00:00Z", revoked_at: a.p_grant ? null : "2026-10-29T02:00:00Z" } });
  return db;
}
const rpcCalls = (db: S6Db) => db.log.filter((c) => c.table === "rpc:sk_set_consent").map((c) => c.payload);

describe("consentRequest — a verified parent only", () => {
  it("a verified parent grants: the RPC runs on the parent's own session", async () => {
    const db = rpcWorld();
    const r = await consentRequest({ session: db, userId: PARENT, role: "parent", body: { child: CHILD, scope: "transcripts", grant: true } });
    expect(r.status).toBe(200);
    expect(rpcCalls(db)).toEqual([{ p_child: CHILD, p_scope: "transcripts", p_grant: true }]);
  });

  it("revoke calls through (p_grant false) — the RPC deletes the memory", async () => {
    const db = rpcWorld();
    const r = await consentRequest({ session: db, userId: PARENT, role: "parent", body: { child: CHILD, scope: "transcripts", grant: false } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, consent: { childId: CHILD, revokedAt: "2026-10-29T02:00:00Z" } } });
    expect(rpcCalls(db)).toEqual([{ p_child: CHILD, p_scope: "transcripts", p_grant: false }]);
  });

  it("an unlinked child, or an UNVERIFIED link → 403 and the RPC is never called", async () => {
    const db = rpcWorld();
    expect((await consentRequest({ session: db, userId: PARENT, role: "parent", body: { child: UNLINKED_CHILD, scope: "voice", grant: true } })).status).toBe(403);
    expect((await consentRequest({ session: db, userId: OTHER_PARENT, role: "parent", body: { child: CHILD, scope: "voice", grant: true } })).status).toBe(403);
    expect(rpcCalls(db)).toEqual([]);
  });

  it("a student can never grant — not for herself, not for anyone", async () => {
    const db = rpcWorld();
    expect((await consentRequest({ session: db, userId: CHILD, role: "student", body: { child: CHILD, scope: "transcripts", grant: true } })).status).toBe(403);
    expect(rpcCalls(db)).toEqual([]);
  });

  it("bad input → 400 (analytics is not offered; grant must be boolean)", async () => {
    const db = rpcWorld();
    for (const body of [{ child: CHILD, scope: "analytics", grant: true }, { child: "x", scope: "voice", grant: true }, { child: CHILD, scope: "voice", grant: "yes" }, null]) {
      expect((await consentRequest({ session: db, userId: PARENT, role: "parent", body })).status).toBe(400);
    }
  });

  it("the database refuses (42501) → 403", async () => {
    const db = world();
    db.rpcs.sk_set_consent = () => ({ data: null, error: { code: "42501", message: "not a verified parent" } });
    expect((await consentRequest({ session: db, userId: PARENT, role: "parent", body: { child: CHILD, scope: "voice", grant: true } })).status).toBe(403);
  });
});

// ── POST /api/sk/school-memory ──────────────────────────────────────────────

describe("schoolMemoryRequest — the principal of their own school only", () => {
  it("a principal switches it on: config MERGED, who and when stored", async () => {
    const db = world();
    db.rows("schools")[0]!.config = { timetable: { days: 5 } };
    const r = await schoolMemoryRequest({ session: db, admin: () => db, userId: PRINCIPAL, body: { on: true }, now: NOW });
    expect(r).toEqual({ status: 200, body: { ok: true, on: true, changedAt: NOW.toISOString() } });
    expect(db.rows("schools")[0]!.config).toEqual({ timetable: { days: 5 }, sk_learning_memory: true, sk_learning_memory_changed: { by: PRINCIPAL, at: NOW.toISOString() } });
  });

  it("a coordinator, a teacher, a parent → 403, nothing written", async () => {
    for (const who of [COORDINATOR, TEACHER, PARENT]) {
      const db = world();
      const r = await schoolMemoryRequest({ session: db, admin: () => db, userId: who, body: { on: true }, now: NOW });
      expect(r.status, who).toBe(403);
      expect(db.touched("schools", "update")).toEqual([]);
    }
  });

  it("another school named in the body → 403 (the school is always the caller's own)", async () => {
    const db = world();
    expect((await schoolMemoryRequest({ session: db, admin: () => db, userId: PRINCIPAL, body: { on: true, schoolId: OTHER_SCHOOL }, now: NOW })).status).toBe(403);
    expect(db.touched("schools", "update")).toEqual([]);
  });

  it("the update goes to the caller's school row only", async () => {
    const db = world();
    db.rows("schools").push({ id: OTHER_SCHOOL, config: {} });
    await schoolMemoryRequest({ session: db, admin: () => db, userId: PRINCIPAL, body: { on: false }, now: NOW });
    expect(db.rows("schools").find((s) => s.id === OTHER_SCHOOL)!.config).toEqual({});
    expect(db.touched("schools", "update")[0]!.filters).toEqual([{ col: "id", op: "eq", value: SCHOOL }]);
  });

  it("bad body → 400", async () => {
    const db = world();
    expect((await schoolMemoryRequest({ session: db, admin: () => db, userId: PRINCIPAL, body: { on: "yes" }, now: NOW })).status).toBe(400);
  });
});

// ── workflow facts in use ───────────────────────────────────────────────────

const CLASS = "c5b00000-0000-4000-8000-000000000001";
describe("workflow facts: recorded from the turn, pending saved when the blob lapses", () => {
  it("a Board deep link → recent_class + recent_kit with their names", () => {
    const notes = workflowFromTurn({
      role: "teacher",
      navigatePath: `/present?class=${CLASS}&kit=gen-1&autostart=1`,
      entities: [
        { kind: "class", id: CLASS, label: "5B", via: "context.resolve" },
        { kind: "generation", id: "gen-1", label: "Plant and Animal Cells", via: "library.find" },
      ],
    });
    expect(notes).toEqual([
      { kind: "recent_class", key: CLASS, value: { label: "5B" } },
      { kind: "recent_kit", key: "kit:gen-1", value: { label: "Plant and Animal Cells", classId: CLASS, classLabel: "5B", generationId: "gen-1" } },
    ]);
  });

  it("a book chapter on the Board; a class used anywhere else; never a student; never an unnamed kit", () => {
    expect(workflowFromTurn({ role: "teacher", navigatePath: "/present?book=b1&chapter=2", entities: [{ kind: "book", id: "b1", label: "Biology", via: "library.find" }] })).toEqual([
      { kind: "recent_kit", key: "book:b1:2", value: { label: "Biology", bookId: "b1", chapterRef: "2" } },
    ]);
    expect(workflowFromTurn({ role: "teacher", navigatePath: "/dashboard/analytics?c=x", entities: [{ kind: "class", id: CLASS, label: "5B", via: "context.resolve" }] })).toEqual([
      { kind: "recent_class", key: CLASS, value: { label: "5B" } },
    ]);
    expect(workflowFromTurn({ role: "student", navigatePath: `/present?class=${CLASS}`, entities: [{ kind: "class", id: CLASS, label: "5B", via: "x" }] })).toEqual([]);
    expect(workflowFromTurn({ role: "teacher", navigatePath: "/present?kit=gen-9", entities: [] })).toEqual([]);
    // a class only remembered from an earlier turn is not "used" again; its name still labels a Board link
    expect(workflowFromTurn({ role: "teacher", navigatePath: null, entities: [], known: [{ kind: "class", id: CLASS, label: "5B", via: "context.resolve" }] })).toEqual([]);
    expect(workflowFromTurn({ role: "teacher", navigatePath: `/present?class=${CLASS}`, entities: [], known: [{ kind: "class", id: CLASS, label: "5B", via: "context.resolve" }] })).toEqual([
      { kind: "recent_class", key: CLASS, value: { label: "5B" } },
    ]);
    expect(boardLink("/dashboard")).toBeNull();
  });

  it("recordWorkflow writes through the owner's session and never throws", async () => {
    const db = s6World();
    expect(await recordWorkflow(db, TEACHER, [{ kind: "recent_class", key: CLASS, value: { label: "5B" } }], { now: NOW, log: () => undefined })).toBe(1);
    expect(db.rows("sk_workflow_facts")[0]).toMatchObject({ owner_id: TEACHER, kind: "recent_class", key: CLASS, value: { label: "5B" } });
    db.fail.add("sk_workflow_facts");
    expect(await recordWorkflow(db, TEACHER, [{ kind: "recent_class", key: CLASS, value: { label: "5B" } }], { now: NOW, log: () => undefined })).toBe(0);
  });

  it("recordWorkflow is time-boxed", async () => {
    const slow = { from: () => ({ upsert: () => new Promise(() => undefined) }) };
    const t0 = Date.now();
    expect(await recordWorkflow(slow, TEACHER, [{ kind: "recent_class", key: CLASS, value: { label: "5B" } }], { timeoutMs: 30, log: () => undefined })).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("pendingToSave: only a LAPSED (4-hour gap) conversation of the same context, waiting on an answer", () => {
    process.env.SK_SHELL_SECRET = "s6c-settings-test-secret-of-adequate-length";
    const ctx = makeCtx();
    const at = (iso: string, pending?: SkMemory["pending"]) => {
      const m = freshMemory(ctx, new Date(iso));
      return sealMemory(pending ? { ...m, pending } : m);
    };
    const now = new Date("2026-10-28T08:30:00Z");
    expect(pendingToSave(at("2026-10-28T02:00:00Z", { task: "notice.post", needs: ["body"] }), ctx, now)).toEqual({ kind: "pending_task", key: "notice.post", value: { task: "notice.post", needs: ["body"] } });
    expect(pendingToSave(at("2026-10-28T07:00:00Z", { task: "notice.post", needs: ["body"] }), ctx, now)).toBeNull(); // still live
    expect(pendingToSave(at("2026-10-28T02:00:00Z"), ctx, now)).toBeNull(); // nothing pending
    expect(pendingToSave(at("2026-10-28T02:00:00Z", { task: "book.activate", needs: ["order"] }), ctx, now)).toBeNull(); // a book code: never
    expect(pendingToSave(at("2026-10-28T02:00:00Z", { task: "notice.post", needs: [] }), makeCtx({ hat: "principal", role: "school_admin" }), now)).toBeNull(); // another context
    expect(pendingToSave("forged.blob", ctx, now)).toBeNull();
  });

  it("the suggestion offers survive the signed blob; an unknown read capability does not", () => {
    process.env.SK_SHELL_SECRET = "s6c-settings-test-secret-of-adequate-length";
    const m = freshMemory(makeCtx(), NOW);
    const board = verifyMemory(sealMemory({ ...m, offer: { target: "board", classId: CLASS, generationId: "gen-1", label: "5B Science" } }));
    expect(board?.offer).toEqual({ target: "board", classId: CLASS, generationId: "gen-1", label: "5B Science" });
    const read = verifyMemory(sealMemory({ ...m, offer: { target: "read", capability: "assignments.status", args: { due: "tomorrow" }, label: "due" } }));
    expect(read?.offer).toEqual({ target: "read", capability: "assignments.status", args: { due: "tomorrow" }, label: "due" });
    const evil = verifyMemory(sealMemory({ ...m, offer: { target: "read", capability: "school.health", args: {}, label: "x" } as never }));
    expect(evil?.offer).toBeUndefined();
    const act = verifyMemory(sealMemory({ ...m, offer: { target: "read", capability: "notice.post", args: {}, label: "x" } as never }));
    expect(act?.offer).toBeUndefined();
  });
});
