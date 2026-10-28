// SK Shell — the shared contracts of stage S0 (Final Plan 2026-10-28 §2.2,
// §2.5, §5.4, §9.7). Pure types: no imports from app code, so every slice
// (Shell UI, Context, registry, tools, tour, voice gate) builds against the
// same shapes and the server/client boundary test stays clean.
//
// Rules these types encode:
// - The Context is built SERVER-SIDE on every turn from the session user; the
//   client's collector is a hint for place/selection only and is never trusted
//   for anything permission-bearing (§2.2).
// - Every capability (tool or action) is a registry entry with a tier, the
//   roles that may see it and a handler; the router sees only the entries the
//   Context allows (§9.7).
// - Facts come from tools; the model narrates. Every answer names its source
//   tools in the transcript metadata (§2.3).

// ── Who, where, what ─────────────────────────────────────────────────────────

/** profiles.role values plus the capability-roles SK reasons about. */
export type SkRole = "teacher" | "student" | "parent" | "school_admin" | "coordinator";
/** The hat the user wears on this request (sc_hat), or null when hats are off. */
export type SkHat = "principal" | "coordinator" | "teacher" | "parent" | null;

export type SkPage =
  | "library"
  | "analytics"
  | "board"
  | "children"
  | "school"
  | "tutor"
  | "kits"
  | "diary"
  | "timetable"
  | "calendar"
  | "console"
  | "other";

export type SkContextUser = {
  id: string;
  email: string | null;
  role: SkRole;
  hat: SkHat;
  schoolId: string | null;
  /** coordinator_scope rows for this school: grade/subject pairs (null = all). */
  coordinatorScope: Array<{ grade: string | null; subject: string | null }>;
  /** public.plan_tier(uid) value, e.g. "school" | "pro" | "trial" | "staff". */
  plan: string;
  locale: string;
  /** Platform staff (platform_admins / FOUNDER_EMAILS). */
  staff: boolean;
};

export type SkPlace = {
  path: string;
  page: SkPage;
  params: Record<string, string>;
};

export type SkSelection = {
  classId?: string;
  learnerId?: string;
  bookId?: string;
  chapterRef?: string;
  generationId?: string;
  productSlug?: string;
};

export type SkBoardState = {
  sessionId: string;
  manifestId?: string;
  move?: string;
  segmentId?: string;
  t?: number;
  paused?: boolean;
  rollPage?: number;
};

/** An entity a tool resolved on an earlier turn, kept so "their parents" and
 *  "that worksheet" resolve without asking again (§5.4). */
export type ResolvedEntity = {
  kind: "class" | "learner" | "learners" | "share" | "generation" | "book" | "chapter" | "topic";
  id: string;
  label: string;
  /** The tool that produced it. */
  via: string;
  /** Extra ids the entity carries (e.g. a learner list's ids). */
  ids?: string[];
};

export type SkContext = {
  user: SkContextUser;
  place: SkPlace;
  selection: SkSelection;
  board?: SkBoardState;
  recent: {
    entities: ResolvedEntity[];
    lastToolResults: Array<{ tool: string; summary: string }>;
  };
  pending?: { task: string; needs: string[] };
  /** The flags and opt-ins that shaped this context, for the registry filter. */
  flags: Record<string, boolean>;
  issuedAt: string;
  ttlSeconds: number;
  /** Stable hash of {role, schoolId, hat, plan}: tokens are bound to it (§8.2). */
  contextHash: string;
};

/** What the client's collector posts with each turn (§5.4). Untrusted. */
export type SkCollector = {
  path: string;
  params?: Record<string, string>;
  selection?: SkSelection;
  board?: SkBoardState;
  /** The browser's local clock, for timetable now/next (there is no per-school
   *  timezone today; the present page uses the browser clock too). */
  clock?: { day: number; minutes: number; iso: string };
  locale?: string;
};

// ── Capabilities ─────────────────────────────────────────────────────────────

export type SkTier = "immediate" | "confirm" | "queued";
export type SkKind = "nav" | "board" | "read" | "act" | "job";

/** JSON-Schema object for the entry's parameters (same shape ToolDef uses). */
export type SkJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type SkCapabilityMeta = {
  /** Registry name, dotted: "navigate", "library.find", "learners.risk". */
  name: string;
  description: string;
  parameters: SkJsonSchema;
  tier: SkTier;
  kind: SkKind;
  /** Roles that may see the entry. Hats narrow further via `hats`. */
  roles: SkRole[];
  hats?: Exclude<SkHat, null>[];
  /** Every listed flag must be true in ctx.flags. */
  flags?: string[];
  /** If set, ctx.user.plan must be one of these. */
  plans?: string[];
};

/** What a handler returns. `facts` is the quotable material; `navigate` is an
 *  immediate-tier instruction for the client; `entities` feed ctx.recent. */
export type SkCapabilityResult = {
  ok: boolean;
  /** Short, model-readable summary of the result (capped by the runner). */
  summary: string;
  /** Structured rows the model may quote verbatim. Empty → "I have nothing on that". */
  facts?: Array<Record<string, string | number | boolean | null>>;
  navigate?: { path: string; label: string };
  entities?: ResolvedEntity[];
  error?: string;
};

/** The narrowest Supabase surface a handler may use. It is ALWAYS the
 *  user-session client (RLS decides what rows exist, §2.3); handlers never
 *  receive the admin client. Typed loosely so tests can pass a fake. */
export type SkSessionDb = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export type SkCapabilityDeps = {
  session: SkSessionDb;
  now: Date;
  /** Local clock from the collector, when the tool needs the user's day/time. */
  clock?: SkCollector["clock"];
  signal?: AbortSignal;
};

export type SkCapability = {
  meta: SkCapabilityMeta;
  handler: (ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps) => Promise<SkCapabilityResult>;
};

// ── The audit row (mirrors SkActionRecord in board-controller and 0162) ──────

export type SkActionRow = {
  actor_id: string | null;
  school_id: string | null;
  role: string | null;
  hat: string | null;
  action: string;
  tier: SkTier;
  kind: SkKind;
  params: Record<string, unknown>;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  session_id: string | null;
  generation_id: string | null;
  token_id?: string | null;
  turn_id: string | null;
  at: string;
  ms: number;
};

// ── Turn protocol (client ⇄ /api/sk/shell/turn) ──────────────────────────────

export type SkTurnRequest = {
  /** Client-minted uuid for idempotent replay. */
  turnId: string;
  text: string;
  /** "voice" when the text came from the microphone (confirmations care, §9.2). */
  modality: "text" | "voice";
  collector: SkCollector;
  /** Opaque, server-signed conversation memory (recent entities, pending task,
   *  last turns, issued-at) returned by the previous turn's `done` event and
   *  echoed back verbatim. The server verifies the signature and the 4-hour
   *  gap; a missing or invalid blob simply starts a new conversation. Needed
   *  because serverless instances share no memory between requests (§5.4). */
  memory?: string;
};

/** SSE events, one JSON object per `data:` line. */
export type SkTurnEvent =
  | { type: "meta"; sessionId: string; turnId: string; intent: SkIntent; capabilities: string[]; memory?: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; ok: boolean; summary: string }
  | { type: "navigate"; path: string; label: string }
  /** S1: an immediate-tier Board move the client executes through the
   *  BoardController (src/app/present/board-controller.ts). The server
   *  decided the move from the Context + Kit Manifest and audited it; the
   *  client only performs it. `say` is the one line SK speaks with the move
   *  (the video is paused while SK speaks, §2.4). */
  | { type: "board"; move: SkBoardMove; args: Record<string, unknown>; say?: string }
  /** S1: a confirm-tier card (§2.5, §8.2). The client renders it and returns
   *  `token` by click or spoken yes; the server executes only with the token. */
  | { type: "confirm"; token: string; action: string; title: string; params: Record<string, string | number | boolean | null>; expiresAt: string }
  | {
      type: "done";
      /** §2.3 / §9.3: which tools the answer rests on, and its label. */
      sources: string[];
      label: "grounded" | "supplementary" | "declined" | "navigation";
      latencyMs: number;
      usage?: { inputTokens: number; outputTokens: number };
      /** The memory blob to echo on the next turn (see SkTurnRequest.memory). */
      memory?: string;
      /** True when the grounding check dropped one or more sentences the tools
       *  did not support; what remains is fully supported (so still grounded). */
      trimmed?: boolean;
    }
  | { type: "error"; message: string };

export type SkIntent = "teach" | "ask" | "navigate" | "act" | "job" | "check" | "chat";

/** The Board moves of Final Plan §2.4, as the client executes them. */
export type SkBoardMove =
  | "intro"
  | "segment"
  | "slide"
  | "explain"
  | "compare"
  | "practise"
  | "walkthrough"
  | "freeze"
  | "blank"
  | "back"
  | "resume"
  | "pause"
  | "recap";

/** The client's answer to a `confirm` card: the token, and how it was given
 *  (§9.2: a spoken yes counts only with exactly one active card and an
 *  intentional mic press). Posted to /api/sk/act. */
export type SkActRequest = {
  turnId: string;
  token: string;
  via: "click" | "voice";
  collector: SkCollector;
  memory?: string;
};

/** The fixed line SK says when every tool came back empty (§2.3). Not a model
 *  output: the route emits it so the unsupported-claims suite is mechanical. */
export const SK_NOTHING_ON_THAT = "I have nothing on that.";
