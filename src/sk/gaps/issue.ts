// SK gap tracker — the platform_issues ticket "Add to SK" files (design §3:
// the same queue as Report-a-problem; a builder session takes it from there).
// Pure. Limits match 0014's checks (title ≤ 200, description ≤ 4000).

export const ISSUE_SAMPLES = 5;

export type IssueTheme = { id: string; title: string; summary: string | null; note?: string | null };
export type IssueSample = { question: string | null; wanted: string | null; role: string | null; signal: string; created_at: string };

const one = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function themeIssue(theme: IssueTheme, samples: IssueSample[], counts?: { d30: number; total: number }) {
  const title = `SK gap: ${one(theme.title, 180)}`.slice(0, 200);
  const lines: string[] = [];
  if (theme.summary) lines.push(one(theme.summary, 600), "");
  if (counts) lines.push(`Missed in ${counts.d30} turn(s) in the last 30 days, ${counts.total} in all.`, "");
  const withText = samples.filter((s) => one(s.question, 1) || one(s.wanted, 1)).slice(0, ISSUE_SAMPLES);
  if (withText.length) {
    lines.push("Sample questions:");
    for (const s of withText) {
      const q = one(s.question, 400) || "(no question text)";
      const w = one(s.wanted, 200);
      lines.push(`- [${s.role ?? "unknown"} · ${s.signal} · ${s.created_at.slice(0, 10)}] ${q}${w ? ` — wanted: ${w}` : ""}`);
    }
    lines.push("");
  }
  if (theme.note) lines.push(`Note: ${one(theme.note, 400)}`, "");
  lines.push(`From the SK gap tracker (console → SK gaps, theme ${theme.id}).`);
  return {
    category: "other" as const,
    severity: "normal" as const,
    status: "open" as const,
    title,
    description: lines.join("\n").slice(0, 4000),
    context: { sk_gap_theme_id: theme.id, source: "sk_gaps" },
  };
}
