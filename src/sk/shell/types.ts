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
  /** S1 (additive): the open segment's 0-based index in `segments`, when known. */
  k?: number;
  /** S1 (additive): the open unit's video generation id. */
  generationId?: string;
  /** S1 (additive): the Board manifest's segments as the client holds them,
   *  so the server resolves "slide 4" / "explain diffusion" without a DB read.
   *  `id` is the manifest segment_id the concepts point at. */
  segments?: Array<{ k: number; heading: string; id?: string; points?: string[] }>;
  /** S1 (additive): the manifest's concepts, each with the segment ids it is taught in. */
  concepts?: Array<{ id: string; name: string; segmentIds: string[] }>;
  /** Additive (founder 2026-10-28): the open unit's .pptx as pages —
   *  absent when the unit has no deck. "ready"/"loaded" let "skip to the
   *  PowerPoint" go to the deck's own first page. */
  deck?: "missing" | "building" | "ready" | "loaded" | "failed";
  /** Additive (founder 2026-10-28, "highlight a portion and ask SK"): the
   *  words she highlighted on a deck page, sent only while the highlight is
   *  live (60 s). `generationId` is the DECK generation, `n` its 1-based slide.
   *  Untrusted like everything here: board.explain_selection re-checks the
   *  deck is hers, and the route keeps only the words that are on the slide. */
  selection?: SkBoardSelection;
  /** 2026-10-31 (additive): the roll's page count, as the Board shows it
   *  ("30 / 54": rollPage is the 0-based 29, rollCount 54). */
  rollCount?: number;
  /** 2026-10-31 (additive): what was loaded onto the roll and where — read
   *  from the roll's own pages (a deck page carries its slide number, a slide
   *  frame its time in the video), so a page inserted anywhere shifts them. */
  roll?: SkRollRange[];
  /** 2026-10-31 (additive): what the page on screen is. */
  rollAt?: SkRollAt;
  /** 2026-10-30 (additive): the open unit's lesson language (the Kit
   *  Manifest's `language`), so SK answers in the kit's language by default.
   *  Not permission-bearing; the teaching call re-reads it from the manifest. */
  language?: string;
};

/** One run of loaded items on the roll (2026-10-31). `from`–`to` are the
 *  roll's OWN page numbers, 1-based, exactly as the Board shows them;
 *  `first`–`last` the item numbers on those pages: deck pages (the .pptx's
 *  slide numbers) or the video's slides (segment k + 1). */
export type SkRollRange = { kind: "video" | "deck"; from: number; to: number; first: number; last: number };

/** The page on screen: a loaded item (deck page n / video slide n), or what else it is. */
export type SkRollAt = { kind: "video" | "deck"; n: number } | { kind: "blank" | "frame" | "card" | "question" | "other" };

/** "Highlight a portion and ask SK" — what the highlight is on (2026-10-31):
 *   deck  (default) a deck page: `generationId` the deck, `n` its slide, `text` the words under the ink;
 *   video a video slide loaded as a page: `generationId` the video, `n` the slide (k + 1), no words
 *         (a frame is pixels; SK explains that slide from the lesson map);
 *   page  any other page (a blank page, her handwriting): nothing SK can read. */
export type SkBoardSelection = { generationId: string; n: number; text: string; title?: string; on?: "deck" | "video" | "page" };

/** S3 slice D: the student's kit player as the Shell sees it (published by
 *  /sk/[product]/[chapter]/kit-player.tsx through the tutor bridge,
 *  src/sk/shell/client/tutor-bridge.ts). UNTRUSTED like every collector field:
 *  the ids only say which kit the student is looking at — every server read
 *  re-runs the kit routes' own entitlement and mapping checks (kit-server.ts
 *  resolveKit) — and the headings only steer the student's own player. */
export type SkTutorState = {
  product: string;
  chapter: string;
  /** The open kit's generation id. */
  kit: string;
  /** The current section: kit-wide 0-based index and manifest key. */
  k?: number;
  key?: string;
  playing?: boolean;
  mode?: "video" | "slide";
  /** The practise panel is open. */
  practising?: boolean;
  /** Section indices watched / practised in this visit (the player's own). */
  watched?: number[];
  practised?: number[];
  /** The kit's sections, so "go to the red blood cells part" resolves without a read. */
  segments?: Array<{ k: number; key: string; heading: string }>;
  /** 2026-10-30 (additive): the kit's lesson language (/api/sk/kit
   *  kit.language). Not permission-bearing; tutor.explain re-reads it. */
  language?: string;
};

/** S3 slice D: the moves the Shell drives on the student's kit player. */
export type SkTutorMove = "play" | "pause" | "restart" | "section" | "slide" | "practise";

/** An entity a tool resolved on an earlier turn, kept so "their parents" and
 *  "that worksheet" resolve without asking again (§5.4). */
export type ResolvedEntity = {
  kind: "class" | "learner" | "learners" | "share" | "generation" | "book" | "chapter" | "topic" | "submission" | "kit";
  id: string;
  label: string;
  /** The tool that produced it. */
  via: string;
  /** Extra ids the entity carries (e.g. a learner list's ids). */
  ids?: string[];
};

/** S4: one of a parent's linked children (parent_links ⋈ profiles, read with
 *  the parent's own session in loadContext). Every parent capability answers
 *  ONLY about a child in this list, and only when `verified` (design decision
 *  5): an id that is not here is refused, whatever the client or model says. */
export type SkChild = {
  id: string;
  /** First word of the display name ("Aisyah"), for speech and matching. */
  firstName: string;
  /** The full display name (full_name, else username). */
  name: string;
  /** parent_links.source: a school-issued link or a parent-created child. */
  source: "school" | "self";
  /** parent_links.verified_at is set. */
  verified: boolean;
  /** The child's profiles.school_id (null for a home learner). */
  schoolId: string | null;
};

export type SkContext = {
  user: SkContextUser;
  /** S4: the parent's linked children (empty/absent for everyone else). */
  children?: SkChild[];
  place: SkPlace;
  selection: SkSelection;
  board?: SkBoardState;
  /** Student Board phase 4: the approved plan's focus line (practice/focus.ts
   *  focusLine), set by the turn route for a student on her Board; "" or absent = none. */
  learnFocus?: string;
  /** S3 slice D: the student's open kit (students on /sk only). */
  tutor?: SkTutorState;
  recent: {
    entities: ResolvedEntity[];
    lastToolResults: Array<{ tool: string; summary: string }>;
  };
  pending?: { task: string; needs: string[] };
  /** The flags and opt-ins that shaped this context, for the registry filter.
   *  Known keys (loadContext): analytics, timetable, calendar, notices (S5:
   *  FEATURE_NOTICES AND the school's calendar gate — utils/flags
   *  noticesEnabledFor, as POST /api/notices), diary, kits, board, hats,
   *  parentPortal, sk, hasChildren, schoolParent, staff, hasScope. */
  flags: Record<string, boolean> & { notices?: boolean };
  issuedAt: string;
  ttlSeconds: number;
  /** Stable hash of {role, schoolId, hat, plan, coordinator scope (S5)}: tokens are bound to it (§8.2). */
  contextHash: string;
  /** 2026-10-30: the language SK answers in this turn (shell/language.ts
   *  answerLanguage) — set by the turn route. `override` is her choice THIS
   *  turn: the question's own language, else the conversation's (a command
   *  or an earlier confident question); null = none. `user.locale` then carries the
   *  locale the fixed lines are looked up in (the same, except zh → en). */
  answer?: { lang: string; from: "question" | "override" | "source" | "ui"; override: string | null; uiLocale: string };
};

/** What the client's collector posts with each turn (§5.4). Untrusted. */
export type SkCollector = {
  path: string;
  params?: Record<string, string>;
  selection?: SkSelection;
  board?: SkBoardState;
  /** S3 slice D: the kit player's state, on /sk/[product]/[chapter]. */
  tutor?: SkTutorState;
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
  /** S1: an immediate-tier Board move for the client to perform (the route
   *  emits it as a `board` event). Only `kind: "board"` entries set this. */
  board?: { move: SkBoardMove; args: Record<string, unknown>; say?: string };
  /** S1: a confirm-tier action with its FULLY RESOLVED params. The route
   *  issues the token (tokens.ts) and emits a `confirm` card; nothing is
   *  written until the client returns that token (§2.5, §8.2). Only
   *  `tier: "confirm"` entries set this. */
  confirm?: { action: string; title: string; params: Record<string, string | number | boolean | null> };
  /** S3 slice D: an immediate-tier move on the student's kit player (the
   *  route emits it as a `tutor` event). Only tutor.* entries set this. */
  tutor?: { move: SkTutorMove; args: Record<string, unknown>; say?: string };
  /** S3 slice D: content a capability already wrote and grounded itself
   *  (tutor.explain runs the kit turn: one metered, grounded model call). The
   *  route says `text` as the answer with this label and these sources. */
  reply?: { text: string; label: "grounded" | "declined"; sources: string[]; usage?: { inputTokens: number; outputTokens: number }; trimmed?: boolean };
  /** S4 slice D: what the conversation's signed memory should hold as the
   *  pending task after this turn (book.activate asking for the order number
   *  or the child keeps the code's HMAC here); null clears it. */
  pending?: { task: string; needs: string[] } | null;
  /** 2026-10-30: the language of the knowledge this result's content comes
   *  from (a kit's manifest, an article, a book) — the answer defaults to it
   *  when every such result agrees (shell/language.ts answerLanguage). */
  language?: string;
  /** S7 K2 (additive): the passages this result's content came from
   *  (knowledge.search, library.find's text search, a kit answer that fell
   *  back to its own book) — the answer's `done` event carries them and the
   *  panel shows them as chips. */
  citations?: SkCitation[];
  /** 2026-10-30 (shell-controls.ts): the model asked for the app walkthrough
   *  — "start" from stop 1, or a move of the running one. The route stops
   *  the model and emits the same `walkthrough` event the rules do. */
  walkthrough?: SkWalkAction;
  /** 2026-10-30 (shell-controls.ts): the model asked to switch the answer
   *  language ("back") or re-say the last answer in one ("repeat"). The route
   *  runs it exactly as the language rule would (language.ts LangCommand). */
  langCommand?: SkLangCommand;
};

/** language.ts LangCommand, structurally (this file imports no app code). */
export type SkLangCommand = { kind: "repeat" | "back"; target: { code: string } | { mine: true } | { unsupported: string } };

/** S7 K2: one source an answer rests on — a SketchCast book, an article or an
 *  upload, with its chapter and the block it came from. */
export type SkCitation = {
  title: string;
  chapter: number | null;
  /** The block's anchor in its source (a section sid, a paragraph p3). */
  anchor: string;
  /** The block's own heading, when it has one. */
  section?: string;
  kind: "sketchcast_book" | "article" | "user_book";
};

/** What /api/sk/act answers after a token is returned (§9.2). */
export type SkActResponse = {
  ok: boolean;
  outcome: "done" | "already_used" | "expired" | "context_mismatch" | "not_found" | "refused" | "error";
  /** One line SK says, e.g. "Assigned Specialised Cells to 7B, due Friday." */
  summary: string;
  result?: Record<string, unknown>;
  memory?: string;
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
  /** Per-TURN read memo (src/sk/capabilities/shared.ts `memo`): one Map made
   *  by the turn route and handed to every capability of that turn, so two
   *  tools in one turn read the teacher's classes once. Never outlives the
   *  request; keys carry the user id. Absent → every read runs. */
  cache?: Map<string, Promise<unknown>>;
  /** S3 slice D: the Shell turn's client-minted id, so a capability that
   *  meters (tutor.explain) can claim it once and replay a resend. */
  turnId?: string | null;
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
  /** 2026-10-30: with modality "voice", the language Amazon Transcribe
   *  identified the speech as ("ms-MY"; identify-language sessions only).
   *  A hint: the words themselves decide when they can
   *  (question-language.ts spokenQuestionLanguage). */
  spokenLang?: string;
  /** 2026-10-30: the first-login walkthrough, while one is on in this tab.
   *  A tour command in it ("continue with the tour") is answered with a
   *  `walkthrough` action and no model call; any other turn tells the model
   *  the tour is there, so SK never says there is none. */
  walk?: SkTurnWalk;
  /** 2026-10-31 (student Board phase 3): a TEACHING turn SK starts by itself —
   *  a gap on the worksheet (`sk:learner-gap`), or the Extra step after the
   *  kit. Untrusted like the collector (learn-teach.ts parseTeachRequest);
   *  only a student on her own Board is taught from it. */
  teach?: SkTeachRequest;
};

/** What starts a teaching turn (learn-teach.ts): a worksheet gap, her
 *  confusion in conversation (decided on the server), the Extra step. */
export type SkTeachTrigger = "gap" | "confusion" | "extra";

/** A teaching turn's request. The gap fields are phase 2's `sk:learner-gap`
 *  detail as the Board dispatched it. */
export type SkTeachRequest = {
  trigger: SkTeachTrigger;
  generationId?: string;
  questionId?: string;
  questionText?: string;
  concept?: string;
  attempts?: number;
  lastAnswer?: string;
  reason?: "wrong_twice" | "asked_help";
};

/** Where the walkthrough is (sanitised server-side; display only, never trusted for access). */
export type SkTurnWalk = { active: boolean; paused: boolean; role: string; stop: string; index: number; total: number };

/** What a `walkthrough` event asks the client's tour to do ("start" = from stop 1). */
export type SkWalkAction = "start" | "resume" | "next" | "back" | "pause" | "skip";

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
  /** S3 slice D: a move on the student's kit player, performed through the
   *  tutor bridge (src/sk/shell/client/tutor-bridge.ts). */
  | { type: "tutor"; move: SkTutorMove; args: Record<string, unknown>; say?: string }
  /** S1: a confirm-tier card (§2.5, §8.2). The client renders it and returns
   *  `token` by click or spoken yes; the server executes only with the token. */
  | { type: "confirm"; token: string; action: string; title: string; params: Record<string, string | number | boolean | null>; expiresAt: string }
  /** 2026-10-30: the language the text that follows is in — its direction,
   *  the read-aloud voice (`speech`, BCP-47) and, when `override` (the user
   *  chose it), the dictation language too. Sent before the text. */
  | { type: "lang"; lang: string; dir: "ltr" | "rtl"; speech: string; override: boolean }
  /** 2026-10-30: "Show me around" — the client (re)starts the first-login
   *  walkthrough from stop 1. Decided by rules, no model; a replay never
   *  writes the seen row. With `action` (2026-10-30): a tour command for the
   *  tour already running in her tab ("…continue with the tour"), no model. */
  | { type: "walkthrough"; action?: SkWalkAction }
  /** 2026-10-31 (student Board phase 3): a picture for the lesson SK is
   *  teaching in the chat — a slide of the open kit's OWN deck (never a new
   *  image). The panel shows that page through /api/present/deck-pages,
   *  which re-checks the deck is hers. */
  | { type: "picture"; generationId: string; n: number; title: string }
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
      /** S7 K2 (additive): the books / articles / uploads the answer came
       *  from, for the panel's citation chips. `sources` stays the TOOL names
       *  (§2.3); these are the documents behind them. */
      citations?: SkCitation[];
      /** 2026-10-31 (student Board phase 3): this reply is a TEACHING turn
       *  (a short lesson, or SK's reply to her check answer) — the panel opens
       *  the conversation so the lesson reads in full. `extra` = beyond the kit. */
      teach?: { trigger: SkTeachTrigger | "check"; extra: boolean };
    }
  | { type: "error"; message: string };

export type SkIntent = "teach" | "ask" | "navigate" | "act" | "job" | "check" | "chat" | "tutor" | "lang" | "tour";

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
  | "recap"
  /** Board UX (2026-10-28): open the unit rail as an overlay — a UI control,
   *  not a controller move; the bridge performs it without an audit row. */
  | "rail"
  /** Put every slide of the open unit on the roll as pages — the video's own
   *  finished frames, one page each (no pptx rendering). */
  | "load_slides"
  /** Put the open unit's .pptx on the roll, one rendered slide per page
   *  (founder 2026-10-28); already there = wind to its first page. */
  | "load_deck"
  /** Explain the part of a deck slide she highlighted (SkBoardState.selection).
   *  Content only: the route answers with text, nothing moves on the Board. */
  | "explain_selection"
  /** 2026-10-31: turn the ROLL to a page — its own number ("30 / 54"), the
   *  next / previous / first / last, or where a deck page or a video slide
   *  was loaded (args.item, re-found on the live roll by the bridge). */
  | "page";

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

/** S1: the fixed line when a confirm-tier action cannot be offered because no
 *  action-token secret is configured (tokens.ts refuses to issue). The action
 *  is then unavailable rather than weak (§8.2). */
export const SK_CANNOT_CONFIRM = "I can't confirm actions right now.";
