import { describe, expect, it } from "vitest";
import { defaultChapter, latestPlan, nextStep, stages, workChapters, type ApprovalLite, type ChapterRow, type RunLite } from "@/utils/books/workbench";

const plan = [1, 2, 3].map((n) => ({ chapter: n, title: `Chapter ${n}` }));
const row = (n: number, sha = `S${n}`): ChapterRow => ({ chapter: n, title: `Ch ${n}`, content_sha256: sha, revision_key: "d1" });
const gd = (id: number, chapter: number, sha: string): ApprovalLite => ({ id, kind: "gate_d", chapter, revision_key: "d1", content_sha256: sha });
const readiness: RunLite = { id: 1, stage_key: "gate_r", status: "done", detail: { summary: { passed: true, pct: 100, plan } } };

describe("book workbench", () => {
  it("lists every planned chapter with its state", () => {
    const runs: RunLite[] = [readiness, { id: 9, stage_key: "draft_chapter", status: "running", params: { chapter: 3 } }];
    const ch = workChapters(latestPlan(runs), [row(1), row(2)], [gd(10, 1, "S1")], runs);
    expect(ch.map((c) => [c.chapter, c.state])).toEqual([[1, "approved"], [2, "ready"], [3, "drafting"]]);
    expect(defaultChapter(ch)).toBe(2);
  });

  it("a book approval of the revision approves its chapters (Biology r4.1)", () => {
    const ch = workChapters(plan, [row(1), row(2), row(3)], [{ id: 5, kind: "book", chapter: null, revision_key: "d1", content_sha256: null }], []);
    expect(ch.every((c) => c.state === "approved")).toBe(true);
  });

  it("each stage offers the one next action", () => {
    const ch = workChapters(plan, [row(1)], [gd(10, 1, "S1")], [readiness]);
    const s = stages({ chapters: ch, runs: [readiness], approvals: [gd(10, 1, "S1")], releases: [], draftUsd: 2.5, auditUsd: 0.58 });
    expect(s.map((x) => [x.key, x.state])).toEqual([["ready", "done"], ["chapters", "ready"], ["book", "ready"], ["audit", "ready"], ["final", "waiting"], ["publish", "waiting"]]);
    expect(s[1].action).toMatchObject({ kind: "run", stage: "draft_chapter", params: { chapter: 2 } });
    expect(s[1].value).toBe("1/3");
  });

  it("all approved → compile; compiled → Gate E; approved → publish; released → done", () => {
    const rows = [row(1), row(2), row(3)];
    const aps = [gd(1, 1, "S1"), gd(2, 2, "S2"), gd(3, 3, "S3")];
    const ch = workChapters(plan, rows, aps, [readiness]);
    const base = { chapters: ch, approvals: aps, releases: [], draftUsd: 2.5, auditUsd: 0.58 };
    expect(stages({ ...base, runs: [readiness] })[4].action).toMatchObject({ kind: "run", stage: "compile_book" });
    const compiled: RunLite = { id: 30, stage_key: "compile_book", status: "done", detail: { summary: { pdf_sha256: "PDF" } } };
    expect(stages({ ...base, runs: [readiness, compiled] })[4].action).toEqual({ kind: "gate_e", run: 30 });
    const ge: ApprovalLite = { id: 11, kind: "gate_e", chapter: null, revision_key: "d1", content_sha256: "PDF", approved_on: "2026-10-30" };
    const withE = stages({ ...base, approvals: [...aps, ge], runs: [readiness, compiled] });
    expect(withE[4].state).toBe("done");
    expect(withE[5].action).toMatchObject({ kind: "run", stage: "release", params: { final: 1 } });
    const done = stages({ ...base, approvals: [...aps, ge], runs: [readiness, compiled], releases: [{ id: 3, release_kind: "final", edition_key: "en-1.1", gate_e_approval_id: 11, superseded_by: null, withdrawn_at: null }] });
    expect(done[5]).toMatchObject({ state: "done", value: "en-1.1" });
    // a front-matter edit after the compile reopens Final: compile again, then Gate E again
    const at = { ...compiled, created_at: "2026-10-30T08:00:00Z" };
    const front = stages({ ...base, approvals: [...aps, ge], runs: [readiness, at], frontChangedAt: "2026-10-30T09:00:00Z" });
    expect(front[4]).toMatchObject({ state: "ready", action: { kind: "run", stage: "compile_book" } });
    expect(stages({ ...base, approvals: [...aps, ge], runs: [readiness, at], frontChangedAt: "2026-10-30T07:00:00Z" })[4].state).toBe("done");
  });
});

describe("book workbench guards", () => {
  it("a final approval does not count while chapters are missing or unapproved", () => {
    const ge: ApprovalLite = { id: 11, kind: "gate_e", chapter: null, revision_key: "d1", content_sha256: "PDF", approved_on: "2026-10-30" };
    const ch = workChapters(plan, [row(1)], [gd(1, 1, "S1")], [readiness]);
    const s = stages({ chapters: ch, runs: [readiness], approvals: [gd(1, 1, "S1"), ge], releases: [], draftUsd: 2.5, auditUsd: 0.58 });
    expect(s[4].state).toBe("waiting");
    expect(s[5].state).toBe("waiting");
  });
});

describe("approvals follow the text", () => {
  it("a chapter carried unchanged into a newer revision keeps its book approval; an edited one does not", () => {
    const book: ApprovalLite = { id: 5, kind: "book", chapter: null, revision_key: "r4.1", content_sha256: null };
    const old = [{ chapter: 1, title: "A", content_sha256: "S1", revision_key: "r4.1" }, { chapter: 2, title: "B", content_sha256: "S2", revision_key: "r4.1" }];
    const now = [{ chapter: 1, title: "A", content_sha256: "S1", revision_key: "d1" }, { chapter: 2, title: "B", content_sha256: "S2-edited", revision_key: "d1" }];
    const ch = workChapters([], now, [book], [], [...old, ...now]);
    expect(ch.map((c) => [c.chapter, c.state])).toEqual([[1, "approved"], [2, "ready"]]);
  });
});

describe("direction C: one next step", () => {
  it("without the chapter plan, the next step is the free chapter list, never Final", () => {
    const one = [{ chapter: 1, title: "A", content_sha256: "S1", revision_key: "d1" }];
    const aps: ApprovalLite[] = [{ id: 1, kind: "gate_d", chapter: 1, revision_key: "d1", content_sha256: "S1" }];
    const ch = workChapters([], one, aps, []);
    const s = stages({ chapters: ch, runs: [], approvals: aps, releases: [], draftUsd: 2.5, auditUsd: 0.58, planKnown: false });
    expect(s[1]).toMatchObject({ state: "ready", value: "1/?", action: { kind: "run", stage: "readiness", label: "List chapters" } });
    expect(s[4].action).toBeUndefined();
    expect(nextStep(s)?.key).toBe("chapters");
  });

  it("with the plan, the next step is drafting the next chapter in sequence", () => {
    const one = [{ chapter: 1, title: "A", content_sha256: "S1", revision_key: "d1" }];
    const aps: ApprovalLite[] = [{ id: 1, kind: "gate_d", chapter: 1, revision_key: "d1", content_sha256: "S1" }];
    const ch = workChapters([{ chapter: 1, title: "A" }, { chapter: 2, title: "B" }, { chapter: 3, title: "C" }], one, aps, []);
    const s = stages({ chapters: ch, runs: [], approvals: aps, releases: [], draftUsd: 2.5, auditUsd: 0.58, planKnown: true });
    expect(nextStep(s)?.action).toMatchObject({ stage: "draft_chapter", params: { chapter: 2 }, label: "Draft 2" });
  });
});
