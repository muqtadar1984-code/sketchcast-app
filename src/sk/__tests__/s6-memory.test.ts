// SK S6 slice A — consent, the fact stores, the tutor's history gate, the
// sweep helper and the delete logic (Final Plan §8.1, §9.5; S6 design
// decisions 1–4, 7). The database side (RLS, the RPC, the trigger, the sweep
// SQL) is held by the 0173 lint and the production dry run.
// Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/s6-memory.test.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { hasConsent, memoryAllowed, setConsent, type RpcDb } from "../consent";
import { noteLearning, recallLearning, recallWorkflow, rememberWorkflow, workflowExpiry } from "../facts";
import { historyAllowed, openSession, runCommand, runTurn, transcriptFree, type LoopDeps } from "../loop";
import { deleteSkMemory } from "../memory-delete";
import { runSkMemorySweep } from "../memory-sweep";
import { StaticItemBank } from "../items";
import { InMemorySessionStore } from "../store";
import type { SseEvent } from "../types";
import { graph, U4_HITMAP_TARGETS, U4_SEGMENT } from "./fixtures";
import { CHILD, OTHER_PARENT, PARENT, S6Db, s6World, SCHOOL_CHILD, TEACHER, UNLINKED_CHILD } from "./s6-fake-db";

const grant = (db: S6Db, guardian: string, child: string, scope = "transcripts", revoked: string | null = null) =>
  db.rows("consents").push({ child_id: child, guardian_id: guardian, scope, granted_at: "2026-10-20T00:00:00Z", revoked_at: revoked });

describe("hasConsent (design decision 2: a verified guardian's row OR the school's switch)", () => {
  it("a verified parent's active grant → true, for that scope only", async () => {
    const db = s6World();
    grant(db, PARENT, CHILD, "transcripts");
    expect(await hasConsent(db, CHILD, "transcripts")).toBe(true);
    expect(await hasConsent(db, CHILD, "voice")).toBe(false);
  });
  it("a revoked grant → false", async () => {
    const db = s6World();
    grant(db, PARENT, CHILD, "transcripts", "2026-10-25T00:00:00Z");
    expect(await hasConsent(db, CHILD, "transcripts")).toBe(false);
  });
  it("a grant from an UNVERIFIED link does not count", async () => {
    const db = s6World();
    grant(db, OTHER_PARENT, CHILD, "transcripts");
    expect(await hasConsent(db, CHILD, "transcripts")).toBe(false);
  });
  it("the school's switch (schools.config.sk_learning_memory = true) → true for its learner; off → false", async () => {
    expect(await hasConsent(s6World({ switchOn: true }), SCHOOL_CHILD, "transcripts")).toBe(true);
    expect(await hasConsent(s6World({ switchOn: false }), SCHOOL_CHILD, "transcripts")).toBe(false);
    // a truthy non-boolean is not a switch
    const db = s6World();
    db.rows("schools")[0]!.config = { sk_learning_memory: "yes" };
    expect(await hasConsent(db, SCHOOL_CHILD, "transcripts")).toBe(false);
  });
  it("none → false; a bad id or scope → false without a read; a failed read → false (fail closed)", async () => {
    const db = s6World();
    expect(await hasConsent(db, CHILD, "transcripts")).toBe(false);
    const before = db.log.length;
    expect(await hasConsent(db, "not-a-uuid", "transcripts")).toBe(false);
    expect(await hasConsent(db, CHILD, "email" as never)).toBe(false);
    expect(db.log.length).toBe(before);
    const broken = s6World();
    grant(broken, PARENT, CHILD);
    broken.fail.add("consents");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await hasConsent(broken, CHILD, "transcripts")).toBe(false);
  });
});

describe("memoryAllowed (consentAllows: adults own their memory; a student needs consent)", () => {
  it("a teacher or parent → true with no consent rows", async () => {
    const db = s6World();
    expect(await memoryAllowed(db, TEACHER, "transcripts")).toBe(true);
    expect(await memoryAllowed(db, PARENT, "transcripts")).toBe(true);
  });
  it("a student → only with consent; an unknown profile → false", async () => {
    const db = s6World();
    expect(await memoryAllowed(db, CHILD, "transcripts")).toBe(false);
    grant(db, PARENT, CHILD);
    expect(await memoryAllowed(db, CHILD, "transcripts")).toBe(true);
    expect(await memoryAllowed(db, "99999999-9999-4999-8999-999999999999", "transcripts")).toBe(false);
  });
});

describe("setConsent — the sk_set_consent RPC wrapper", () => {
  const session = (reply: { data?: unknown; error?: { code?: string; message?: string } | null }) => {
    const rpc = vi.fn(async () => reply);
    return { rpc, db: { rpc } as unknown as RpcDb };
  };
  it("refuses a non-parent (the database's 42501)", async () => {
    const s = session({ data: null, error: { code: "42501", message: "sk_set_consent: not a verified parent of this child" } });
    expect(await setConsent(s.db, CHILD, "transcripts", true)).toEqual({ ok: false, reason: "not_parent" });
    expect(s.rpc).toHaveBeenCalledWith("sk_set_consent", { p_child: CHILD, p_scope: "transcripts", p_grant: true });
  });
  it("refuses a bad scope or id before calling the database", async () => {
    const s = session({ data: null, error: null });
    expect(await setConsent(s.db, CHILD, "email", true)).toEqual({ ok: false, reason: "bad_input" });
    expect(await setConsent(s.db, "x", "voice", true)).toEqual({ ok: false, reason: "bad_input" });
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("returns the consent row on a grant and on a revoke", async () => {
    const g = session({ data: { child_id: CHILD, scope: "voice", granted_at: "2026-10-29T00:00:00Z", revoked_at: null }, error: null });
    expect(await setConsent(g.db, CHILD, "voice", true)).toEqual({ ok: true, consent: { childId: CHILD, scope: "voice", grantedAt: "2026-10-29T00:00:00Z", revokedAt: null } });
    const r = session({ data: { child_id: CHILD, scope: "voice", granted_at: "2026-10-29T00:00:00Z", revoked_at: "2026-10-29T01:00:00Z" }, error: null });
    expect(await setConsent(r.db, CHILD, "voice", false)).toMatchObject({ ok: true, consent: { revokedAt: "2026-10-29T01:00:00Z" } });
  });
});

describe("learning facts", () => {
  const note = { kind: "misconception" as const, objectiveKey: "a1b2c3d4-0000-4000-8000-000000000000:o2", detail: { misconception_id: "m2" }, source: "sk.kit.remediation" };
  it("noteLearning is a no-op without consent: it reads consent and NEVER writes", async () => {
    const db = s6World();
    expect(await noteLearning(db, CHILD, note)).toEqual({ stored: false, reason: "no_consent" });
    expect(db.touched("sk_learning_facts")).toEqual([]);
    expect(db.rows("sk_learning_facts")).toEqual([]);
  });
  it("noteLearning writes with a verified parent's consent, and with the school's switch", async () => {
    const db = s6World();
    grant(db, PARENT, CHILD);
    expect(await noteLearning(db, CHILD, note)).toEqual({ stored: true });
    expect(db.rows("sk_learning_facts")).toMatchObject([{ student_id: CHILD, kind: "misconception", objective_key: note.objectiveKey, source: "sk.kit.remediation" }]);
    const school = s6World({ switchOn: true });
    expect(await noteLearning(school, SCHOOL_CHILD, note)).toEqual({ stored: true });
  });
  it("noteLearning refuses a bad kind or source without reading anything", async () => {
    const db = s6World();
    expect(await noteLearning(db, CHILD, { ...note, kind: "secret" as never })).toEqual({ stored: false, reason: "bad_input" });
    expect(await noteLearning(db, CHILD, { ...note, source: "Bad Source" })).toEqual({ stored: false, reason: "bad_input" });
    expect(db.log).toEqual([]);
  });
  it("recallLearning returns the student's own live rows", async () => {
    const db = s6World();
    db.rows("sk_learning_facts").push(
      { id: "f1", student_id: CHILD, kind: "strength", objective_key: null, detail: {}, source: "x.y", created_at: "2026-10-28", expires_at: "2027-01-01T00:00:00Z" },
      { id: "f2", student_id: CHILD, kind: "struggled", objective_key: null, detail: {}, source: "x.y", created_at: "2026-10-27", expires_at: "2026-10-01T00:00:00Z" },
      { id: "f3", student_id: SCHOOL_CHILD, kind: "strength", objective_key: null, detail: {}, source: "x.y", created_at: "2026-10-28", expires_at: "2027-01-01T00:00:00Z" },
    );
    const got = await recallLearning(db, CHILD, new Date("2026-10-29T00:00:00Z"));
    expect(got.map((f) => f.id)).toEqual(["f1"]);
  });
});

describe("workflow facts", () => {
  it("rememberWorkflow upserts one row per (owner, kind, key) with a 12-month expiry", async () => {
    const db = s6World();
    const now = new Date("2026-10-29T10:00:00Z");
    expect(await rememberWorkflow(db, TEACHER, "recent_kit", "gen-1", { title: "Cells" }, now)).toBe(true);
    expect(await rememberWorkflow(db, TEACHER, "recent_kit", "gen-1", { title: "Cells v2" }, now)).toBe(true);
    expect(db.rows("sk_workflow_facts")).toHaveLength(1);
    expect(db.rows("sk_workflow_facts")[0]).toMatchObject({ owner_id: TEACHER, kind: "recent_kit", key: "gen-1", value: { title: "Cells v2" }, expires_at: "2027-10-29T10:00:00.000Z" });
    expect(workflowExpiry(now)).toBe("2027-10-29T10:00:00.000Z");
  });
  it("refuses a bad kind, an empty key or an oversized value", async () => {
    const db = s6World();
    expect(await rememberWorkflow(db, TEACHER, "Recent Kit", "k", {})).toBe(false);
    expect(await rememberWorkflow(db, TEACHER, "recent_kit", "  ", {})).toBe(false);
    expect(await rememberWorkflow(db, TEACHER, "recent_kit", "k", { big: "x".repeat(7000) })).toBe(false);
    expect(db.log).toEqual([]);
  });
  it("recallWorkflow returns the owner's live rows of the kinds asked, newest first", async () => {
    const db = s6World();
    db.rows("sk_workflow_facts").push(
      { owner_id: TEACHER, kind: "recent_kit", key: "a", value: 1, updated_at: "2026-10-27", expires_at: "2027-10-01" },
      { owner_id: TEACHER, kind: "recent_class", key: "b", value: 2, updated_at: "2026-10-28", expires_at: "2027-10-01" },
      { owner_id: TEACHER, kind: "preference", key: "c", value: 3, updated_at: "2026-10-28", expires_at: "2027-10-01" },
      { owner_id: TEACHER, kind: "recent_kit", key: "old", value: 4, updated_at: "2026-10-29", expires_at: "2026-10-01" },
      { owner_id: PARENT, kind: "recent_kit", key: "theirs", value: 5, updated_at: "2026-10-29", expires_at: "2027-10-01" },
    );
    const got = await recallWorkflow(db, TEACHER, ["recent_kit", "recent_class"], new Date("2026-10-29T00:00:00Z"));
    expect(got.map((f) => f.key)).toEqual(["b", "a"]);
  });
});

// ── the tutor keeps history only with consent ───────────────────────────────

function loopDeps(extra: Partial<LoopDeps> = {}): LoopDeps {
  return { store: new InMemorySessionStore(), graph: graph(), items: new StaticItemBank(), loadSegment: async () => U4_SEGMENT, loadHitmapElementIds: async () => U4_HITMAP_TARGETS, ...extra };
}
const collect = async (gen: AsyncGenerator<SseEvent>) => {
  const out: SseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const ask = (d: LoopDeps, s: Awaited<ReturnType<typeof openSession>>, q: string) =>
  collect(runTurn(d, s, { eventId: eid(), utterance: { text: q, modality: "typed" }, cursor: { unitKey: "u2", assetId: "u2-main", t: 20_000 } }));

describe("the tutor's history (sk_sessions.history) — kept only with transcripts consent", () => {
  it("historyAllowed: absent → keep; false → not; a failing check → not (fail closed)", async () => {
    expect(await historyAllowed({}, "stu")).toBe(true);
    expect(await historyAllowed({ keepHistory: async () => false }, "stu")).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await historyAllowed({ keepHistory: async () => Promise.reject(new Error("db down")) }, "stu")).toBe(false);
  });
  it("WITH consent: the question and answer are saved and reach the next turn's model call", async () => {
    const provider = new StubProvider([{ text: ["The eyepiece is the top lens."] }, { text: ["Yes."] }]);
    const d = loopDeps({ teacherProvider: provider, keepHistory: async () => true });
    const s = await openSession(d, { studentId: "stu", productId: "test-product", chapter: 2 });
    await runCommand(d, s, { name: "continue", args: {} });
    await ask(d, s, "which lens is the eyepiece?");
    expect((await d.store.getSession(s.id))!.history).toHaveLength(2);
    await runCommand(d, s, { name: "continue", args: {} });
    await ask(d, s, "is it the top one?");
    expect(provider.calls[1]!.messages.length).toBe(3); // 2 history turns + the question
  });
  it("WITHOUT consent: nothing is saved, and history stored earlier never reaches the model", async () => {
    const provider = new StubProvider([{ text: ["The eyepiece is the top lens."] }, { text: ["Yes."] }]);
    const d = loopDeps({ teacherProvider: provider, keepHistory: async () => false });
    const s = await openSession(d, { studentId: "stu", productId: "test-product", chapter: 2 });
    // history left from before consent was withdrawn
    s.history = [{ role: "user", text: "old question" }, { role: "assistant", text: "old answer" }];
    await d.store.saveSession(s);
    await runCommand(d, s, { name: "continue", args: {} });
    const evs = await ask(d, s, "which lens is the eyepiece?");
    expect(evs.filter((e) => e.event === "text").map((e) => e.data).join("")).toBe("The eyepiece is the top lens.");
    expect(provider.calls[0]!.messages).toEqual([{ role: "user", text: "which lens is the eyepiece?" }]);
    expect((await d.store.getSession(s.id))!.history).toEqual([]);
  });
  it("transcriptFree drops the words and asides from a stored replay, keeps meta and done", () => {
    const evs: SseEvent[] = [
      { event: "meta", data: { intent: "question" } },
      { event: "text", data: 'Did you say "my answer"?' },
      { event: "tal", data: {} },
      { event: "done", data: { ok: true } },
    ];
    expect(transcriptFree(evs).map((e) => e.event)).toEqual(["meta", "done"]);
  });
});

// ── the retention sweep helper ──────────────────────────────────────────────

describe("runSkMemorySweep — guarded", () => {
  it("returns the counts from sk_memory_sweep()", async () => {
    const db = new S6Db();
    db.rpcs.sk_memory_sweep = () => ({ data: { workflow_facts: 2, learning_facts: 1, history_cleared: 0, sk_actions: 3 } });
    expect(await runSkMemorySweep(() => db)).toEqual({ workflow_facts: 2, learning_facts: 1, history_cleared: 0, sk_actions: 3 });
  });
  it("a missing function, an error or a missing service key only logs and returns null", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSkMemorySweep(() => new S6Db())).toBeNull();
    expect(
      await runSkMemorySweep(() => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
      }),
    ).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

// ── delete my SK memory ─────────────────────────────────────────────────────

function memoryWorld() {
  const session = s6World();
  const admin = new S6Db({
    sk_learning_facts: [
      { id: "l1", student_id: CHILD, kind: "misconception", source: "x.y" },
      { id: "l2", student_id: UNLINKED_CHILD, kind: "misconception", source: "x.y" },
    ],
    sk_sessions: [
      { id: "s1", student_id: CHILD, product_id: "kit:g1", history: [{ role: "user", text: "q" }] },
      { id: "s2", student_id: CHILD, product_id: "kit:g2", history: [] },
      { id: "s3", student_id: UNLINKED_CHILD, product_id: "kit:g1", history: [{ role: "user", text: "q" }] },
      { id: "s4", student_id: TEACHER, product_id: "kit:g9", history: [{ role: "user", text: "mine" }] },
    ],
    sk_events: [
      { session_id: "s1", event_id: "e1", kind: "turn", result: [{ event: "text", data: "words" }] },
      { session_id: "s1", event_id: "e2", kind: "kit_answer", result: { outcome: "correct" } },
      { session_id: "s3", event_id: "e3", kind: "turn", result: [{ event: "text", data: "other" }] },
    ],
    item_attempts: [{ id: "a1", session_id: "s1", student_id: CHILD }],
  });
  return { session, admin };
}

describe("deleteSkMemory", () => {
  it("own: workflow + learning facts through the SESSION client, history through the service role; attempts stay", async () => {
    const { session, admin } = memoryWorld();
    session.rows("sk_workflow_facts").push({ owner_id: TEACHER, kind: "recent_kit", key: "a" }, { owner_id: PARENT, kind: "recent_kit", key: "b" });
    const r = await deleteSkMemory({ session, admin: () => admin, userId: TEACHER });
    expect(r).toEqual({ status: 200, body: { ok: true, scope: "own", deleted: { workflowFacts: 1, learningFacts: 0, sessionsCleared: 1, turnsCleared: 0 } } });
    expect(session.rows("sk_workflow_facts").map((x) => x.owner_id)).toEqual([PARENT]);
    expect(admin.rows("sk_sessions").find((x) => x.id === "s4")!.history).toEqual([]);
    // the session itself is kept (its attempts are educational records)
    expect(admin.rows("sk_sessions")).toHaveLength(4);
    expect(admin.touched("sk_workflow_facts")).toEqual([]);
    expect(admin.touched("item_attempts")).toEqual([]);
  });
  it("own, a student: their learning facts, their history and their turns' stored words go; another student's stay", async () => {
    const { admin } = memoryWorld();
    const session = new S6Db({ sk_workflow_facts: [], sk_learning_facts: [{ id: "l1", student_id: CHILD }, { id: "lx", student_id: UNLINKED_CHILD }] });
    const r = await deleteSkMemory({ session, admin: () => admin, userId: CHILD });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: "own", deleted: { workflowFacts: 0, learningFacts: 1, sessionsCleared: 1, turnsCleared: 1 } });
    expect(session.rows("sk_learning_facts").map((x) => x.id)).toEqual(["lx"]);
    expect(admin.rows("sk_events").find((e) => e.event_id === "e1")!.result).toEqual([]);
    expect(admin.rows("sk_events").find((e) => e.event_id === "e2")!.result).toEqual({ outcome: "correct" });
    expect(admin.rows("sk_events").find((e) => e.event_id === "e3")!.result).toEqual([{ event: "text", data: "other" }]);
    expect(admin.rows("item_attempts")).toHaveLength(1);
  });
  it("child: a verified parent deletes the child's learning facts and tutor history", async () => {
    const { session, admin } = memoryWorld();
    const r = await deleteSkMemory({ session, admin: () => admin, userId: PARENT, childId: CHILD });
    expect(r).toEqual({ status: 200, body: { ok: true, scope: "child", deleted: { workflowFacts: 0, learningFacts: 1, sessionsCleared: 1, turnsCleared: 1 } } });
    expect(admin.rows("sk_learning_facts").map((x) => x.id)).toEqual(["l2"]);
    expect(admin.rows("sk_sessions").find((x) => x.id === "s3")!.history).toHaveLength(1);
    // the link was checked on the parent's own session, filtered to the parent
    expect(session.touched("parent_links")[0]!.filters).toEqual([
      { col: "parent_id", op: "eq", value: PARENT },
      { col: "child_id", op: "eq", value: CHILD },
    ]);
  });
  it("child: an unlinked child, an UNVERIFIED link or yourself is refused before the service role is made", async () => {
    for (const [userId, childId] of [
      [PARENT, UNLINKED_CHILD],
      [OTHER_PARENT, CHILD],
      [PARENT, PARENT],
    ] as const) {
      const { session } = memoryWorld();
      const admin = vi.fn(() => new S6Db());
      const r = await deleteSkMemory({ session, admin, userId, childId });
      expect(r.status).toBe(403);
      expect(admin).not.toHaveBeenCalled();
    }
  });
  it("a database error → 500 with a plain message", async () => {
    const { session, admin } = memoryWorld();
    session.fail.add("sk_workflow_facts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await deleteSkMemory({ session, admin: () => admin, userId: TEACHER });
    expect(r.status).toBe(500);
  });
});

// ── nothing sent unasked (S6 acceptance 1) ──────────────────────────────────

describe("nothing is sent unasked: no S6 code path can send mail or a push", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const S6_FILES = [
    "src/sk/consent.ts",
    "src/sk/facts.ts",
    "src/sk/memory-delete.ts",
    "src/sk/memory-sweep.ts",
    "src/app/api/sk/memory/route.ts",
    // S6 slice C: the settings, the greeting suggestion, workflow facts in use.
    "src/sk/prefs.ts",
    "src/sk/settings.ts",
    "src/sk/shell/suggest.ts",
    "src/sk/shell/suggest-lines.ts",
    "src/sk/shell/workflow.ts",
    "src/app/api/sk/prefs/route.ts",
    "src/app/api/sk/consent/route.ts",
    "src/app/api/sk/school-memory/route.ts",
    "src/app/api/sk/shell/context/route.ts",
    "src/app/dashboard/settings/page.tsx",
    "src/app/dashboard/settings/lines.ts",
    "src/app/dashboard/settings/sk-privacy.tsx",
    // slice B — Transcribe (the client half's network surface is pinned in
    // src/utils/__tests__/transcribe.test.ts)
    "src/app/api/sk/stt/url/route.ts",
    "src/sk/speech/stt.ts",
    "src/sk/speech/transcribe-presign.ts",
    "src/sk/speech/transcribe-server.ts",
    "src/utils/assistant/transcribe-client.ts",
    "src/utils/assistant/event-stream.ts",
    "src/utils/assistant/pcm16.ts",
    "src/utils/assistant/voice-client.ts",
  ];
  const SENDERS = /from\s+["'](?:resend|nodemailer|@sendgrid\/[^"']+|postmark|web-push|@\/utils\/lifecycle\/send|@\/utils\/email[^"']*|@\/utils\/mail[^"']*)["']|\bnew Resend\(|sendLifecycleEmail|sendEmail\(|sendMail\(/;

  it("the S6 modules import no mail or push sender", () => {
    for (const f of S6_FILES) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(SENDERS);
  });
  it("…nor does anything they import from src/sk (one level)", () => {
    const seen = new Set<string>();
    for (const f of S6_FILES) {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const m of src.matchAll(/from\s+["'](\.\/[^"']+|@\/sk\/[^"']+)["']/g)) {
        const rel = m[1]!.startsWith("@/") ? m[1]!.replace("@/", "src/") : path.join(path.dirname(f), m[1]!);
        const base = rel.replace(/\\/g, "/");
        seen.add(existsSync(path.join(ROOT, `${base}.ts`)) ? `${base}.ts` : `${base}.tsx`);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const f of seen) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(SENDERS);
  });
  it("S6 slice C: a suggestion reads no school.* tool, and lives only in the greeting the user opened", () => {
    const suggest = readFileSync(path.join(ROOT, "src/sk/shell/suggest.ts"), "utf8");
    // No school-wide (metered, S5) module is imported, and no school.* tool is named.
    expect(suggest).not.toMatch(/from\s+["']@\/sk\/capabilities\/(school|school-figures)["']|school-meter/);
    const tools = suggest.match(/SUGGEST_TOOLS = \[([^\]]*)\]/)?.[1] ?? "";
    expect(tools).toContain("timetable.now_next");
    expect(tools).not.toMatch(/school\./);
    // Nothing in the engine, the workflow memory or the settings core calls out.
    for (const f of ["src/sk/shell/suggest.ts", "src/sk/shell/workflow.ts", "src/sk/settings.ts", "src/sk/prefs.ts", "src/app/api/sk/shell/context/route.ts"]) {
      expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon|new Notification\(|showNotification\(/);
    }
  });
  it("the sweep is called from the cron BEFORE (and independent of) its email section", () => {
    const cron = readFileSync(path.join(ROOT, "src/app/api/lifecycle/reminders/route.ts"), "utf8");
    const sweep = cron.indexOf("runSkMemorySweep(createAdminClient)");
    expect(sweep).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(cron.indexOf("LIFECYCLE_EMAILS_SINCE not set"));
    expect(readdirSync(path.join(ROOT, "src/sk")).includes("memory-sweep.ts")).toBe(true);
  });
});
