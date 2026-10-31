// SK gap tracker — the console's per-theme counts (distinct turns, dismissed
// excluded) and the ticket "Add to SK" files.
// Run: node node_modules/vitest/vitest.mjs run src/sk/gaps/__tests__/stats-issue.test.ts
import { describe, expect, it } from "vitest";
import { byWeight, themeStats, type GapCountRow } from "@/sk/gaps/stats";
import { themeIssue } from "@/sk/gaps/issue";

const NOW = new Date("2026-10-31T00:00:00.000Z");
const row = (theme_id: string, turn_id: string, daysAgo: number, extra: Partial<GapCountRow> = {}): GapCountRow => ({
  theme_id,
  turn_id,
  role: "teacher",
  signal: "self",
  status: "grouped",
  created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
  ...extra,
});

describe("themeStats", () => {
  it("counts distinct turns per window, skips dismissed, mixes roles and signals", () => {
    const s = themeStats(
      [
        row("A", "t1", 1),
        row("A", "t1", 1, { signal: "phrase" }), // same turn, second signal: counts once
        row("A", "t2", 10, { role: "student" }),
        row("A", "t3", 60, { role: "student", signal: "thumbs_down" }),
        row("A", "t4", 2, { status: "dismissed" }),
        row("B", "t9", 3),
      ],
      NOW,
    );
    expect(s.get("A")).toEqual({
      d30: 2,
      d7: 1,
      total: 3,
      roles: [
        ["student", 2],
        ["teacher", 1],
      ],
      signals: [
        ["self", 2],
        ["phrase", 1],
        ["thumbs_down", 1],
      ],
      lastSeen: row("A", "t1", 1).created_at,
    });
    const order = byWeight(
      [
        { id: "B", last_seen_at: null },
        { id: "A", last_seen_at: null },
        { id: "C", last_seen_at: "2026-10-30T00:00:00Z" },
      ],
      s,
    ).map((t) => t.id);
    expect(order).toEqual(["A", "B", "C"]);
  });
});

describe("themeIssue", () => {
  it("files an 'other' ticket with the summary, at most 5 samples and the theme link", () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({
      question: i === 0 ? null : `Question ${i}`,
      wanted: i === 1 ? "send to class" : null,
      role: "teacher",
      signal: "self",
      created_at: "2026-10-30T00:00:00Z",
    }));
    const t = themeIssue({ id: "TH", title: "Email a worksheet to the class", summary: "Teachers want SK to email." }, samples);
    expect(t).toMatchObject({ category: "other", status: "open", title: "SK gap: Email a worksheet to the class", context: { sk_gap_theme_id: "TH", source: "sk_gaps" } });
    expect(t.description).toContain("Teachers want SK to email.");
    expect(t.description).toContain("Question 1 — wanted: send to class");
    expect(t.description).toContain("Question 5");
    expect(t.description).not.toContain("Question 6");
    expect(t.description.length).toBeLessThanOrEqual(4000);
  });
});
