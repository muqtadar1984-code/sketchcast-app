// Row shapes of the topic-catalogue tables (migrations 0112 + 0113), as the
// Library portal consumes them. Pure types: shared by the Server Components, the
// route handlers and the client panels without pulling either side's runtime
// into the other.

export type TopicStatus =
  | "candidate"
  | "approved"
  | "article_approved"
  | "generating"
  | "in_review"
  | "video_approved"
  | "published"
  | "retired";

export type BankMaturity = "none" | "basic" | "good" | "strong" | "assessment" | "exam_ready";

export type Topic = {
  id: string;
  canonical_key: string;
  title: string;
  subject: string | null;
  summary: string | null;
  teacher_avatar: string | null;
  depth_node_id: string | null;
  prerequisites: string[] | null;
  status: TopicStatus;
  bank_maturity: BankMaturity | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AliasSource = "curriculum" | "book" | "manual";

export type TopicAlias = {
  id: string;
  topic_id: string;
  alias: string;
  normalized: string;
  source: AliasSource;
};

export type Coverage = "full" | "partial";

/** The level of a curriculum node (0113: curriculum_nodes.kind). Nullable in
 *  the table — a seed may leave it unset and nodeKind() infers it from the
 *  code's shape the way the 0113 backfill did. */
export type NodeKind = "strand" | "sub_strand" | "objective" | "unit" | "chapter" | "topic";

export type Curriculum = {
  id: string;
  code: string;
  name: string;
  kind: string | null;
  country: string | null;
  edition: string | null;
  source_url: string | null;
};

export type CurriculumNode = {
  id: string;
  curriculum_id: string;
  code: string;
  grade: string | null;
  strand: string | null;
  sub_strand: string | null;
  title: string;
  description: string | null;
  parent_id: string | null;
  sort: number | null;
  kind: NodeKind | null;
};

export type TopicMapping = {
  id: string;
  topic_id: string;
  node_id: string;
  coverage: Coverage;
  notes: string | null;
};

export type CandidateSource = "book" | "curriculum";
export type CandidateStatus = "open" | "merged" | "created" | "dismissed";

export type TopicCandidate = {
  id: string;
  source_kind: CandidateSource;
  book_id: string | null;
  node_id: string | null;
  /** 0113: the objectives a GROUPED curriculum candidate proposes to map;
   *  node_id is then the anchor (the sub-strand or unit). Empty for a book
   *  candidate and for a one-node curriculum candidate. */
  node_ids: string[];
  /** 0113: the model's one-line reason for the grouping. */
  rationale: string | null;
  raw_title: string;
  normalized: string;
  suggested_topic_id: string | null;
  status: CandidateStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

/** What the topic-search picker (GET /api/library/topics?q=) returns per hit. */
export type TopicHit = Pick<Topic, "id" | "title" | "subject" | "status" | "canonical_key">;

/** What the node-search picker (GET /api/library/curricula/[id]/nodes?q=) returns
 *  per hit. `kind` is the resolved level (column, else inferred from the code);
 *  `children` counts the node's direct children, so the mapping panel can offer
 *  "map all N objectives" for a group node. */
export type NodeHit = Pick<CurriculumNode, "id" | "code" | "grade" | "strand" | "sub_strand" | "title"> & {
  kind: NodeKind | null;
  children: number;
};

// ── Knowledge articles (0112 §3; Phase 2b) ───────────────────────────────────

export type ArticleStatus = "draft" | "in_review" | "approved" | "superseded" | "rejected";
export type ArticleAuthor = "model" | "staff";

export type ArticleObjective = { id: string; text: string };

/** One ordered section. `figure_keys` name article_figures.figure_key rows of
 *  the same article; `covers` lists the objective ids the section teaches. */
export type ArticleSection = {
  id: string;
  heading: string;
  body_md: string;
  figure_keys: string[];
  covers: string[];
};

export type GlossaryEntry = { term: string; definition: string };
export type Misconception = { id: string; misconception: string; correction: string };
export type WorkedExample = { id: string; problem: string; solution_md: string };
/** A discrete fact or formula, tied to the section that states it. */
export type Claim = { id: string; text: string; section_id: string };

export type TopicArticle = {
  id: string;
  topic_id: string;
  version: number;
  language: string;
  source_article_id: string | null;
  title: string;
  objectives: ArticleObjective[];
  sections: ArticleSection[];
  glossary: GlossaryEntry[];
  misconceptions: Misconception[];
  worked_examples: WorkedExample[];
  claims: Claim[];
  depth_node_id: string | null;
  depth_rationale: string | null;
  word_count: number;
  status: ArticleStatus;
  author: ArticleAuthor;
  reviewer_id: string | null;
  reviewed_at: string | null;
  approved_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type FigureStatus = "draft" | "rendered" | "approved" | "rejected";

/** What to draw: the subject, the parts to label, an optional style and notes
 *  for the renderer. */
export type FigureSpec = { subject: string; parts: string[]; style: string | null; notes: string | null };

export type ArticleFigure = {
  id: string;
  article_id: string;
  figure_key: string;
  caption: string | null;
  spec: FigureSpec;
  /** worker-owned visual_assets.id (no FK); set once figure_render succeeded */
  visual_asset_id: string | null;
  labels: { group_id: string; label: string }[];
  sort: number;
  status: FigureStatus;
  /** 0114: why the last render failed, so the editor can say so */
  render_error: string | null;
  created_at: string;
};

/** The editable part of an article as the Save action carries it: everything
 *  a human may change on a draft. Versioning, status, authorship and review
 *  fields are the routes' business, never the editor's. */
export type ArticleBody = {
  title: string;
  objectives: ArticleObjective[];
  sections: ArticleSection[];
  glossary: GlossaryEntry[];
  misconceptions: Misconception[];
  worked_examples: WorkedExample[];
  claims: Claim[];
  depth_rationale: string | null;
  figures: ArticleFigureInput[];
};

/** A figure as the editor sends it (the renderer's fields are not editable). */
export type ArticleFigureInput = {
  figure_key: string;
  caption: string | null;
  spec: FigureSpec;
  sort: number;
};
