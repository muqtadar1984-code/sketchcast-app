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
  steps: GapStep[];
};

export type Curriculum = { id: string; code: string; name: string };

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
