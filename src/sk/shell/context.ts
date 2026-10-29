// SK Shell — the Context object (Final Plan §2.2, §5.4).
//
// `buildContext` is PURE: everything permission-bearing (role, school, hat,
// scope rows, plan, staff, flags) is handed in by the server loader from the
// session; the client's collector contributes place and selection only, as
// hints. `loadContext` is the server half: it runs the reads the header already
// runs for its tabs (coordinator_scope, parent_links, the tenant's flags) and
// the ONE admin read allowed here — `plan_tier(uid)`.

import type { SkBoardState, SkCollector, SkContext, SkContextUser, SkHat, SkPage, SkRole, SkSelection } from "./types";
import { contextHash } from "./hash";
import { hatsFor, resolveHat, HAT_COOKIE, isHat } from "@/utils/hats";
import {
  calendarEnabledFor,
  catalogueTabEnabled,
  diaryEnabled,
  parentPortalEnabled,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  skEnabled,
  timetableEnabledFor,
  presentAllowed,
} from "@/utils/flags";
import { presentAccess } from "@/utils/present/access";
import { founderEmails, staffUserIds } from "@/utils/platform-admin";

export const SK_CONTEXT_TTL_SECONDS = 4 * 60 * 60;

const ROLES: ReadonlySet<string> = new Set<SkRole>(["teacher", "student", "parent", "school_admin", "coordinator"]);

/** profiles.role → SkRole. Unknown or missing → the least-privileged role. */
export function roleFor(role: string | null | undefined): SkRole {
  const r = (role ?? "").toLowerCase();
  return ROLES.has(r) ? (r as SkRole) : "student";
}

/** Which Shell page a pathname belongs to. Query strings are ignored. */
export function pageFor(path: string | null | undefined): SkPage {
  const p = (path ?? "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  if (p === "/present" || p.startsWith("/present/")) return "board";
  if (p === "/sk" || p.startsWith("/sk/")) return "tutor";
  if (p === "/console" || p.startsWith("/console/")) return "console";
  if (p === "/dashboard") return "library";
  if (p === "/dashboard/analytics") return "analytics";
  if (p === "/dashboard/children" || p.startsWith("/dashboard/children/")) return "children";
  if (p === "/dashboard/kits" || p.startsWith("/dashboard/kits/")) return "kits";
  if (p === "/dashboard/diary" || p.startsWith("/dashboard/diary/")) return "diary";
  if (p === "/dashboard/my-timetable" || p === "/dashboard/school/timetable") return "timetable";
  if (p === "/dashboard/calendar" || p.startsWith("/dashboard/calendar/")) return "calendar";
  if (p === "/dashboard/school" || p.startsWith("/dashboard/school/")) return "school";
  if (p.startsWith("/dashboard/")) return "library";
  return "other";
}

const SELECTION_KEYS = ["classId", "learnerId", "bookId", "chapterRef", "generationId", "productSlug"] as const;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= max ? s : undefined;
}

/** The collector is untrusted: keep only known keys, bounded strings. */
export function sanitizeSelection(sel: unknown): SkSelection {
  const out: SkSelection = {};
  if (!sel || typeof sel !== "object") return out;
  for (const k of SELECTION_KEYS) {
    const v = str((sel as Record<string, unknown>)[k], 120);
    if (v) out[k] = v;
  }
  return out;
}

export function sanitizeParams(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params || typeof params !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (n++ >= 20) break;
    const key = str(k, 40);
    const val = typeof v === "string" ? v.slice(0, 200) : undefined;
    if (key && val !== undefined) out[key] = val;
  }
  return out;
}

const DECK_STATES: ReadonlySet<string> = new Set(["missing", "building", "ready", "loaded", "failed"]);

export function sanitizeBoard(board: unknown): SkBoardState | undefined {
  if (!board || typeof board !== "object") return undefined;
  const b = board as Record<string, unknown>;
  const sessionId = str(b.sessionId, 120);
  if (!sessionId) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const strs = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, n) : undefined);
  const out: SkBoardState = {
    sessionId,
    manifestId: str(b.manifestId, 120),
    move: str(b.move, 60),
    segmentId: str(b.segmentId, 120),
    t: num(b.t),
    paused: typeof b.paused === "boolean" ? b.paused : undefined,
    rollPage: num(b.rollPage),
    k: int(b.k),
    generationId: str(b.generationId, 120),
  };
  if (typeof b.deck === "string" && DECK_STATES.has(b.deck)) out.deck = b.deck as NonNullable<SkBoardState["deck"]>;
  // The highlighted words on a deck page: a deck id, a slide number, at most
  // 600 characters of text. Anything malformed drops the selection whole.
  if (b.selection && typeof b.selection === "object") {
    const s = b.selection as Record<string, unknown>;
    const generationId = str(s.generationId, 120);
    const n = typeof s.n === "number" && Number.isInteger(s.n) && s.n >= 1 && s.n <= 1000 ? s.n : undefined;
    const text = typeof s.text === "string" ? s.text.replace(/\s+/g, " ").trim().slice(0, 600).trim() : "";
    const title = typeof s.title === "string" ? s.title.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (generationId && n !== undefined && text) out.selection = { generationId, n, text, ...(title ? { title } : {}) };
  }
  // S1: the lesson map the client holds, bounded — at most 200 segments and 60
  // concepts, short headings, a handful of points each.
  if (Array.isArray(b.segments)) {
    const segments: NonNullable<SkBoardState["segments"]> = [];
    for (const raw of b.segments.slice(0, 200)) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const k = int(s.k);
      if (k === undefined) continue;
      const heading = typeof s.heading === "string" ? s.heading.trim().slice(0, 160) : "";
      const id = str(s.id, 120);
      const points = strs(s.points, 8, 200);
      segments.push({ k, heading, ...(id ? { id } : {}), ...(points?.length ? { points } : {}) });
    }
    out.segments = segments;
  }
  if (Array.isArray(b.concepts)) {
    const concepts: NonNullable<SkBoardState["concepts"]> = [];
    for (const raw of b.concepts.slice(0, 60)) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      const id = str(c.id, 120);
      const name = str(c.name, 120);
      if (!id || !name) continue;
      concepts.push({ id, name, segmentIds: strs(c.segmentIds, 40, 120) ?? [] });
    }
    out.concepts = concepts;
  }
  return out;
}

export type BuildContextInput = {
  user: { id: string; email: string | null };
  role: string | null;
  schoolId: string | null;
  hat: SkHat;
  coordinatorScope: Array<{ grade: string | null; subject: string | null }>;
  plan: string;
  staff: boolean;
  flags: Record<string, boolean>;
  collector: SkCollector | null | undefined;
  now: Date;
  locale?: string | null;
  ttlSeconds?: number;
};

/** Pure. Everything permission-bearing comes from `input`, never from the collector. */
export function buildContext(input: BuildContextInput): SkContext {
  const role = roleFor(input.role);
  const hat: SkHat = role === "student" ? null : input.hat;
  const plan = input.plan || "unknown";
  const collector = input.collector ?? null;
  const path = str(collector?.path, 300) ?? "/dashboard";
  const locale = str(input.locale ?? collector?.locale, 10) ?? "en";
  const user: SkContextUser = {
    id: input.user.id,
    email: input.user.email,
    role,
    hat,
    schoolId: input.schoolId,
    coordinatorScope: input.coordinatorScope.map((s) => ({ grade: s.grade ?? null, subject: s.subject ?? null })),
    plan,
    locale,
    staff: input.staff,
  };
  return {
    user,
    place: { path, page: pageFor(path), params: sanitizeParams(collector?.params) },
    selection: sanitizeSelection(collector?.selection),
    board: sanitizeBoard(collector?.board),
    recent: { entities: [], lastToolResults: [] },
    flags: { ...input.flags, hasScope: input.coordinatorScope.length > 0 },
    issuedAt: input.now.toISOString(),
    ttlSeconds: input.ttlSeconds ?? SK_CONTEXT_TTL_SECONDS,
    contextHash: contextHash({ role, schoolId: input.schoolId, hat, plan }),
  };
}

/** The roles a context satisfies: its profile role, plus "coordinator" when it
 *  holds scope rows in its school (a coordinator is a grant, not a role). */
export function effectiveRoles(ctx: SkContext): SkRole[] {
  const roles: SkRole[] = [ctx.user.role];
  if (ctx.user.coordinatorScope.length && ctx.user.role !== "student" && ctx.user.role !== "parent") roles.push("coordinator");
  return roles;
}

// ── Server loader ────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SessionLike = { from: (table: string) => any; auth?: unknown };
export type AdminLike = { from: (table: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type LoadContextDeps = {
  session: SessionLike;
  /** Service-role client, or null when the key is absent (plan → "unknown"). */
  admin: AdminLike | null;
  /** The request's cookie store (next/headers `cookies()`); only `sc_hat` is read. */
  cookies?: { get(name: string): { value: string } | undefined } | null;
  user: { id: string; email?: string | null; email_confirmed_at?: string | null };
  profile: { role: string | null; school_id: string | null };
  collector: SkCollector | null | undefined;
  /** The negotiated UI locale (sc_locale cookie / collector); presentation only. */
  locale?: string | null;
  now?: Date;
};

export async function loadContext(deps: LoadContextDeps): Promise<SkContext> {
  const now = deps.now ?? new Date();
  const role = deps.profile.role;
  const schoolId = deps.profile.school_id;
  const session = deps.session;
  const adult = !!role && role !== "student";

  const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const rows = async (q: unknown): Promise<Record<string, unknown>[]> => {
    const r = (await safe(Promise.resolve(q as Promise<{ data?: unknown }>), {} as { data?: unknown })) as { data?: unknown };
    return Array.isArray(r?.data) ? (r.data as Record<string, unknown>[]) : [];
  };

  const [scopeRows, links, analyticsOn, timetableOn, calendarOn, planRes, staffIds] = await Promise.all([
    adult && schoolId
      ? rows(session.from("coordinator_scope").select("grade, subject").eq("coordinator_id", deps.user.id).eq("school_id", schoolId))
      : Promise.resolve([] as Record<string, unknown>[]),
    adult && parentPortalEnabled()
      ? rows(session.from("parent_links").select("source").eq("parent_id", deps.user.id).limit(20))
      : Promise.resolve([] as Record<string, unknown>[]),
    // `as never`: these helpers type the client as SupabaseClient; the loader
    // only needs `.from`, so tests can pass a fake.
    adult ? safe(schoolAnalyticsEnabledFor(session as never, schoolId), false) : Promise.resolve(false),
    adult ? safe(timetableEnabledFor(session as never, schoolId), false) : Promise.resolve(false),
    adult ? safe(calendarEnabledFor(session as never, schoolId), false) : Promise.resolve(false),
    deps.admin ? safe(Promise.resolve(deps.admin.rpc("plan_tier", { uid: deps.user.id })), { data: null }) : Promise.resolve({ data: null }),
    deps.admin ? staffUserIds(deps.admin as never) : Promise.resolve(new Set<string>()),
  ]);

  const coordinatorScope = scopeRows.map((r) => ({ grade: (r.grade as string | null) ?? null, subject: (r.subject as string | null) ?? null }));
  const hasScope = coordinatorScope.length > 0;
  const hasChildren = links.length > 0;
  const schoolParent = links.some((l) => l.source === "school");
  const planData = (planRes as { data?: unknown })?.data;
  const plan = typeof planData === "string" && planData ? planData : "unknown";
  const email = (deps.user.email ?? "").toLowerCase();
  const staff = (!!email && founderEmails().includes(email)) || staffIds.has(deps.user.id);
  const diaryOn = diaryEnabled();

  let hat: SkHat = null;
  if (roleHatsEnabled() && adult) {
    const hats = hatsFor({ role, hasScope, hasChildren, analyticsOn, timetableOn, diaryOn });
    const cookie = deps.cookies?.get(HAT_COOKIE)?.value;
    hat = resolveHat(isHat(cookie) ? cookie : null, hats);
  }

  const board = presentAccess({ role, tier: plan === "unknown" ? null : plan, override: presentAllowed(deps.user) }).ok;

  return buildContext({
    user: { id: deps.user.id, email: deps.user.email ?? null },
    role,
    schoolId,
    hat,
    coordinatorScope,
    plan,
    staff,
    flags: {
      analytics: analyticsOn,
      timetable: timetableOn,
      calendar: calendarOn,
      diary: diaryOn,
      kits: catalogueTabEnabled() && adult,
      board,
      hats: roleHatsEnabled(),
      parentPortal: parentPortalEnabled(),
      sk: skEnabled(),
      hasChildren,
      schoolParent,
      staff,
    },
    collector: deps.collector,
    locale: deps.locale ?? null,
    now,
  });
}
