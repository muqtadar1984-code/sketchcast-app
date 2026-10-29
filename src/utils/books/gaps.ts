// The book's gaps: what its latest readiness re-check found outstanding, topic by
// topic, with the planner's next steps (worker publishing/runner/readiness.py →
// the run's detail.summary.gaps). Pure: the Gaps tab reads it, and each gap links
// to the Library page where its next step is carried out.

export type GapStep = {
  order: number;
  step: string;
  job_type: string | null;
  language: string | null;
  usd: number | null;
  review_min: number | null;
  note: string | null;
};

/** One failing (or waived) audit check of a gap, with the audit's own reason (runs from 29 Oct on). */
export type GapCheck = { code: string; language: string | null; verdict: "fail" | "warn"; sub_status: string | null; detail: string | null };

export type Gap = {
  title: string;
  topic_id: string | null;
  topic_slug: string | null;
  topic_status: string | null;
  chapter: number | null;
  chapter_title: string | null;
  node_codes: string[] | null;
  role: string | null;
  state: string;
  failing: string[] | null;
  checks?: GapCheck[];
  steps: GapStep[];
};

export type Curriculum = { id: string; code: string; name: string };

export const CHECK_LABEL: Record<string, string> = {
  B1: "Topic exists in the catalogue",
  B2: "Mapped to the curriculum objectives",
  B3: "Approved English article",
  B4: "Article depth (words, worked examples, glossary, objectives, figures rendered)",
  B5: "Question bank mature enough",
  B6: "English kit built from the approved article",
  B7: "English video published",
  B8: "Translated article",
  B9: "Translated kit",
  B10: "Translated video published",
  B11: "No failed or pending jobs",
};

/** The failing checks an editor may waive for this book: every failure except a missing topic (B1 — there is nothing
 * to write the chapter from). Older runs carry only the codes ("B6/en"), without the reason or the kind of failure. */
export function waivable(gap: Gap): GapCheck[] {
  if (!gap.topic_id) return [];
  const checks: GapCheck[] = gap.checks?.length
    ? gap.checks.filter((c) => c.verdict === "fail")
    : (gap.failing ?? []).map((f) => {
        const [code, language] = f.split("/");
        return { code, language: language ?? null, verdict: "fail" as const, sub_status: null, detail: null };
      });
  return checks.filter((c) => c.code !== "B1");
}

export const LIBRARY = "https://library.sketchcast.app";

export const STATE_LABEL: Record<string, string> = {
  missing_topic: "No catalogue topic yet",
  needs_improvement: "Article needs improvement",
  kit_or_publication_incomplete: "Kit or publication incomplete",
  missing_video_publication: "Video not published",
  missing_mapping: "Not mapped to the curriculum",
  missing_translation: "Translation missing",
};

/** Where the next step is done: the topic's own Library page, or — for a topic that does not exist yet — its
 * curriculum, where "Create topic from node" starts it. Null when neither is known. */
export function libraryLink(gap: Gap, curriculum: Curriculum | null): { href: string; label: string } | null {
  if (gap.topic_id) return { href: `${LIBRARY}/library/topics/${gap.topic_id}`, label: "Open the topic in the Library" };
  if (curriculum) return { href: `${LIBRARY}/library/curricula?curriculum=${curriculum.id}`, label: `Create it from ${curriculum.code} in the Library` };
  return null;
}

/** Cost and review time to close one gap (steps with no estimate count as zero). */
export function gapTotals(gap: Gap): { usd: number; reviewMin: number } {
  return gap.steps.reduce(
    (t, s) => ({ usd: t.usd + Number(s.usd ?? 0), reviewMin: t.reviewMin + Number(s.review_min ?? 0) }),
    { usd: 0, reviewMin: 0 },
  );
}

/** The gaps grouped by chapter, in chapter order, with the book-wide totals. */
export function groupGaps(gaps: Gap[]): { chapters: { chapter: number | null; title: string | null; gaps: Gap[] }[]; usd: number; reviewMin: number } {
  const byChapter = new Map<number | null, { chapter: number | null; title: string | null; gaps: Gap[] }>();
  let usd = 0;
  let reviewMin = 0;
  for (const g of gaps) {
    const c = byChapter.get(g.chapter) ?? { chapter: g.chapter, title: g.chapter_title, gaps: [] };
    c.gaps.push(g);
    byChapter.set(g.chapter, c);
    const t = gapTotals(g);
    usd += t.usd;
    reviewMin += t.reviewMin;
  }
  const chapters = [...byChapter.values()].sort((a, b) => (a.chapter ?? 999) - (b.chapter ?? 999));
  return { chapters, usd, reviewMin };
}
