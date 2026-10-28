// Row shapes of the book app's store (migration 0161), as the importer
// (worker publishing/tools/books_import.py) writes them. Pure types.

export type Work = {
  uid: string;
  slug: string;
  title: string;
  subtitle: string | null;
  subject_strand: string;
  curriculum_code: string;
  grade_band: string | null;
  age_band: string | null;
  language: string;
  status: string;
  current_revision: string | null;
  facts: { chapters?: number; questions?: number; figures?: number; words?: number; kdp_pages?: number };
};

export type BookRevision = { work_uid: string; key: string; ordinal: number; label: string; summary: string | null };

export type Block = {
  type: string;
  text?: string;
  term?: string;
  wrong?: string;
  right?: string;
  answer?: string;
  problem?: string;
  steps?: string[];
  items?: (string | { ref?: string; label?: string })[];
  ordered?: boolean;
  headers?: string[];
  rows?: string[][];
  caption?: string;
  ref?: string;
  relations?: { from: number; to: number; kind?: string; label?: string }[];
  layout?: { placement?: string; width?: string; why?: string } | string;
  source_refs?: string[];
};

export type Section = { sid: string; heading: string; blocks: Block[] };

export type Exercise = {
  xid: string;
  tier?: string;
  item_type?: string;
  stem?: string;
  options?: string[] | null;
  pairs?: { left: string; right: string }[] | null;
  categories?: string[] | null;
  items?: { text?: string; category?: string }[] | null;
  answer?: string;
  marking_scheme?: { point?: string; marks?: number }[];
  figure_ref?: string | null;
  figure_refs?: string[] | null;
  figure_context?: Record<string, string> | null;
};

export type FigureInfo = {
  store: "visual-assets" | "s3";
  path: string | null;
  kind: "photo" | "illustration";
  caption: string | null;
  labels: string[];
  size: [number | null, number | null] | null;
  credit: { licence?: string; author?: string; url?: string; provider?: string; note?: string } | null;
};

export type ChapterBody = {
  chapter?: { number?: number; title?: string; node_codes?: string[]; purpose?: string };
  plan?: unknown;
  sections: Section[];
  exercises: Exercise[];
  review?: { gates?: Record<string, string>; ready_for_gate_d?: boolean };
  figures?: Record<string, FigureInfo>;
};

export type ChapterSummary = {
  id: number;
  revision_key: string;
  chapter: number;
  title: string;
  content_sha256: string;
  figure_refs: string[];
  words: number | null;
  questions: number | null;
  source_path: string | null;
};

export type ChapterRevision = ChapterSummary & { work_uid: string; body: ChapterBody };

export type Stage = {
  id: number;
  ordinal: number;
  key: string;
  title: string;
  summary: string | null;
  status: string;
  started_on: string | null;
  finished_on: string | null;
  revision_key: string | null;
  sources: string[];
};

export type Approval = {
  id: number;
  kind: string;
  scope: string;
  chapter: number | null;
  revision_key: string | null;
  stage_key: string | null;
  label: string | null;
  approved_by: string;
  approved_on: string;
  basis: string | null;
  content_sha256: string | null;
  hash_of: string | null;
  hash_verified: boolean | null;
  waived: string[];
  open_flags: string[];
};

export type Run = {
  id: number;
  stage_key: string;
  label: string;
  chapters: number[];
  status: string;
  usd: number | null;
  source_path: string | null;
  detail?: { _failed?: Record<string, string>; _finished_later?: number[]; summary?: Record<string, unknown> } & Record<string, unknown>;
  // runs started from the app or a terminal (0165); imported history has trigger "import" and none of these
  work_uid?: string;
  trigger?: "import" | "app" | "cli";
  params?: Record<string, number>;
  requested_by?: string | null;
  estimate_usd?: number | null;
  progress?: { step?: string; note?: string; chapter?: number };
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  heartbeat_at?: string | null;
  cancel_requested_at?: string | null;
  error?: string | null;
};

export type RunEvent = { id: number; at: string; level: string; kind: string; message: string };

export type Finding = {
  id: number;
  revision_key: string;
  chapter: number | null;
  finding_key: string | null;
  source: string;
  severity: string | null;
  agreement: string | null;
  category: string | null;
  location: string | null;
  quote: string | null;
  problem: string | null;
  fix: string | null;
  confidence: number | null;
  raised_by: string[];
  ruling: { verdict?: string; why?: string; fix?: string; by?: string } | null;
  status: string;
  decision: { applied?: string; unit?: string; verified?: boolean | null } | null;
};

export type Artifact = {
  id: number;
  stage_key: string | null;
  revision_key: string | null;
  chapter: number | null;
  kind: string;
  title: string;
  rel_path: string;
  bytes: number | null;
  sha256: string | null;
  content_type: string | null;
  storage: string;
  storage_key: string | null;
  /** a screen copy of a large PDF (opens in the browser); the full file stays the download (0162) */
  screen_key?: string | null;
  screen_bytes?: number | null;
  /** the run that produced it (0165); null for imported files */
  run_id?: number | null;
};

export type CostLine = { stage_key: string; revision_key: string | null; chapter: number | null; model: string | null; role: string | null; usd: number; run_id?: number | null };

export type OpenItem = { id: number; key: string; title: string; detail: string | null; owner: string | null; status: string };

export type Annotation = {
  figure_ref: string;
  body: { size?: [number, number]; anchors?: Record<string, [number, number]>; unverified?: string[] };
};
