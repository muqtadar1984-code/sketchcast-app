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
