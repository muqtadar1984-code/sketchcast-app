// SK S7 K2 — a student's answer from her knowledge (kit-turn.ts
// runKnowledgeExplain) and the kit explain's own-book fallback: ONE grounded
// model call over the passages as DATA, METERED ONCE through meterUsage (the
// same write point and production wiring as the kit explain), SK's own line
// and no model without tutor access, citations on `done`, the citation line
// under the answer, and no answer key in anything the model is given.
// Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/knowledge-turn.test.ts
import { describe, expect, it } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { LIVE_ENDED_TEXT } from "../access-notice";
import { SupabaseEntitlements } from "../entitlement";
import { runKitExplain, runKnowledgeExplain, passageLine, type KitTurnDeps } from "../kit-turn";
import { SupabaseSessionStore } from "../store-supabase";
import type { SseEvent } from "../types";
import type { Passage } from "../knowledge/answer";
import { PRODUCT, SLUG } from "./cells-fixtures";
import { kitManifest } from "./kit-fixtures";
import { cellsDb, staffGrant, STUDENT } from "./supabase-loop-deps";
import { SK_STUDENT_KNOWLEDGE_RULES, SK_STUDENT_RULES } from "../shell/prompt";

const T0 = Date.parse("2026-10-15T10:00:00Z");
const now = () => T0;

function harness(opts: { teacher?: StubProvider; expiredTutor?: boolean } = {}) {
  const grant = staffGrant(T0);
  const db = cellsDb(now, { grants: [opts.expiredTutor ? { ...grant, tutor_expires_at: new Date(T0 - 1000).toISOString() } : grant] });
  const store = new SupabaseSessionStore(db, { now, pollMs: 1, inflightTimeoutMs: 500 });
  const deps: KitTurnDeps = { store, entitlements: new SupabaseEntitlements(db), teacherProvider: opts.teacher, now };
  return { db, deps };
}

const P: Passage = { kind: "sketchcast_book", source_id: "cells-structure", source_title: "Biology", chapter: 5, anchor: "s3", section: "Specialised cells", text: "Specialised cells such as red blood cells carry oxygen. Nerve cells carry signals.", language: "en" };
const AR: Passage = { kind: "user_book", source_id: "book-own-ar", source_title: "كتابي", chapter: 2, anchor: "p4", section: "التنفس", text: "التنفس الخلوي يطلق الطاقة من الغلوكوز داخل الخلايا.", language: "ar" };
const CITE = "From: Biology · ch 5 · Specialised cells";

async function ask(deps: KitTurnDeps, passages: Passage[] = [P], question = "what are specialised cells?"): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of runKnowledgeExplain(deps, { studentId: STUDENT, productSlug: SLUG, passages, question, language: "English", cite: CITE, rules: SK_STUDENT_KNOWLEDGE_RULES })) out.push(ev);
  return out;
}
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => e.data).join("");
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { metered?: { live_turns: number }; label: string; trimmed?: boolean; citations?: unknown[] };

describe("runKnowledgeExplain — one grounded call, metered once", () => {
  it("answers from the passages, adds SK's citation line, ONE sk_usage live_turns", async () => {
    const teacher = new StubProvider([{ text: ["Specialised cells such as red blood cells carry oxygen."] }]);
    const h = harness({ teacher });
    const evs = await ask(h.deps);
    expect(text(evs)).toBe(`Specialised cells such as red blood cells carry oxygen.\n${CITE}`);
    expect(done(evs)).toMatchObject({ label: "grounded", metered: { live_turns: 1, generated_segments: 0 }, citations: [{ title: "Biology", chapter: 5, anchor: "s3", section: "Specialised cells", kind: "sketchcast_book" }] });
    expect(teacher.calls).toHaveLength(1);
    expect(h.db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, product_id: PRODUCT, live_turns: 1, generated_segments: 0 })]);
  });

  it("the model gets the passages as DATA and the knowledge student rules (no answer key: there is none to give)", async () => {
    const teacher = new StubProvider([{ text: ["Nerve cells carry signals."] }]);
    await ask(harness({ teacher }).deps);
    const sys = teacher.calls[0]!.system;
    expect(sys).toContain('<knowledge data_only="true">');
    expect(sys).toContain("--- [1] Biology · chapter 5 · Specialised cells ---");
    expect(sys).toContain(SK_STUDENT_KNOWLEDGE_RULES);
    expect(SK_STUDENT_KNOWLEDGE_RULES).not.toBe(SK_STUDENT_RULES);
    expect(SK_STUDENT_KNOWLEDGE_RULES).toContain("Never give the answer to a practice or quiz question");
    expect(sys).toContain("Never give the answer to an exercise");
  });

  it("an invented fact is dropped; nothing left → the passage's own words (still grounded)", async () => {
    const teacher = new StubProvider([{ text: ["Specialised cells were found by Robert Hooke in 1665."] }]);
    const evs = await ask(harness({ teacher }).deps);
    expect(text(evs)).toBe(`${passageLine(P)}\n${CITE}`);
    expect(done(evs)).toMatchObject({ label: "grounded", trimmed: true });
  });

  it("without tutor access: SK's own line, no model call, nothing metered, no citations", async () => {
    const teacher = new StubProvider([{ text: ["never"] }]);
    const h = harness({ teacher, expiredTutor: true });
    const evs = await ask(h.deps);
    expect(text(evs)).toBe(LIVE_ENDED_TEXT);
    expect(done(evs)).toMatchObject({ label: "declined" });
    expect(done(evs).metered).toBeUndefined();
    expect(done(evs).citations).toBeUndefined();
    expect(teacher.calls).toHaveLength(0);
    expect(h.db.rows("sk_usage")).toEqual([]);
  });

  it("an Arabic passage goes to the model as Arabic DATA", async () => {
    const teacher = new StubProvider([{ text: ["التنفس الخلوي يطلق الطاقة."] }]);
    const evs = await ask(harness({ teacher }).deps, [AR], "ما هو التنفس الخلوي؟");
    expect(teacher.calls[0]!.system).toContain(AR.text);
    expect(done(evs).citations).toEqual([{ title: "كتابي", chapter: 2, anchor: "p4", section: "التنفس", kind: "user_book" }]);
  });
});

describe("runKitExplain — the kit's own book when the narration falls short", () => {
  it("knowledge joins TEACHING in the ONE call, widens the grounding, cites, meters once", async () => {
    const teacher = new StubProvider([{ text: ["Nerve cells carry signals."] }]);
    const h = harness({ teacher });
    const out: SseEvent[] = [];
    for await (const ev of runKitExplain(h.deps, { studentId: STUDENT, productSlug: SLUG, manifest: kitManifest(), segmentKey: "p1:s001", question: "what do nerve cells do?", language: "English", knowledge: [P], cite: CITE })) out.push(ev);
    expect(teacher.calls).toHaveLength(1);
    expect(teacher.calls[0]!.system).toContain('<teaching data_only="true">');
    expect(teacher.calls[0]!.system).toContain('<knowledge data_only="true">');
    expect(teacher.calls[0]!.messages[0]!.text).toContain("answer from the passages in KNOWLEDGE (this lesson's own book)");
    expect(text(out)).toBe(`Nerve cells carry signals.\n${CITE}`);
    expect(done(out)).toMatchObject({ label: "grounded", metered: { live_turns: 1 }, citations: [expect.objectContaining({ title: "Biology", chapter: 5 })] });
    expect(h.db.rows("sk_usage")[0]).toMatchObject({ live_turns: 1 });
  });

  it("without knowledge the kit explain is unchanged (no KNOWLEDGE block, no citations)", async () => {
    const teacher = new StubProvider([{ text: ["A cell is the smallest unit of life."] }]);
    const h = harness({ teacher });
    const out: SseEvent[] = [];
    for await (const ev of runKitExplain(h.deps, { studentId: STUDENT, productSlug: SLUG, manifest: kitManifest(), segmentKey: "p1:s001", question: "why are cells small?", language: "English" })) out.push(ev);
    expect(teacher.calls[0]!.system).not.toContain("<knowledge");
    expect(done(out).citations).toBeUndefined();
  });
});
