// `navigate` — the immediate-tier capability that moves the user to a portal
// page (Final Plan §2.5). Deterministic: a target enum plus optional filters
// becomes a path, and a target the role/hat cannot see is REFUSED. The
// visibility rules mirror src/utils/nav-tabs.ts (tabsForHat with a hat,
// tabsFor without) — duplicated on purpose: nav-tabs takes the dictionary's
// t() labels and the header's NavTab type, which this server module must not
// drag in. Keep the two in step; the navigate matrix test pins this side.

import type { SkCapability, SkCapabilityResult, SkContext } from "@/sk/shell/types";

export const NAV_TARGETS = [
  "library",
  "analytics",
  "board",
  "children",
  "school",
  "school_teachers",
  "school_access",
  "school_admin",
  "school_books",
  "kits",
  "diary",
  "school_diary",
  "timetable",
  "calendar",
  "tutor",
  "reports",
] as const;
export type NavTarget = (typeof NAV_TARGETS)[number];

export type NavFilters = { classId?: string; learnerId?: string; topic?: string; day?: string; month?: string };

export const NAV_LABEL: Record<NavTarget, string> = {
  library: "Library",
  analytics: "My Analytics",
  board: "Classroom board",
  children: "My children",
  school: "School",
  school_teachers: "Teachers",
  school_access: "Access",
  school_admin: "School admin",
  school_books: "School books",
  kits: "Ready-made kits",
  diary: "Diary",
  school_diary: "School diary",
  timetable: "Timetable",
  calendar: "Calendar",
  tutor: "SK Tutor",
  reports: "Progress record",
};

export function isNavTarget(s: unknown): s is NavTarget {
  return typeof s === "string" && (NAV_TARGETS as readonly string[]).includes(s);
}

/** The targets this context may open — the same set its header shows. */
export function navTargetsFor(ctx: SkContext): NavTarget[] {
  const role = ctx.user.role;
  const hat = ctx.user.hat;
  const f = ctx.flags;
  const hasScope = ctx.user.coordinatorScope.length > 0;
  const leader = role === "school_admin" || hasScope;
  const out = new Set<NavTarget>();
  const authoring = () => {
    out.add("library");
    out.add("analytics");
    if (f.kits) out.add("kits");
    if (f.sk) out.add("tutor");
  };
  const leadership = (principal: boolean) => {
    if (f.analytics) {
      out.add("school");
      out.add("school_teachers");
      out.add("school_access");
      if (principal) out.add("school_admin");
      out.add("school_books");
    }
    if (f.diary) out.add("school_diary");
    if (f.timetable) out.add("timetable");
  };

  if (role === "student") {
    // tabsFor: My lessons (/dashboard), SK, diary, my timetable.
    out.add("library");
    if (f.sk) out.add("tutor");
    if (f.diary) out.add("diary");
    if (f.timetable) out.add("timetable");
    return [...out];
  }

  if (hat === "teacher") {
    authoring();
    if (f.board) out.add("board");
    if (f.diary) out.add("diary");
    if (f.timetable) out.add("timetable");
    if (f.calendar) out.add("calendar");
    out.add("reports");
    return [...out];
  }
  if (hat === "parent") {
    // A consumer parent authors; a school-provisioned parent watches.
    if (!f.schoolParent) authoring();
    out.add("children");
    if (f.diary) out.add("diary");
    if (f.calendar) out.add("calendar");
    out.add("reports");
    return [...out];
  }
  if (hat === "principal" || hat === "coordinator") {
    leadership(hat === "principal");
    if (f.calendar) out.add("calendar");
    return [...out];
  }

  // No hat (FEATURE_ROLE_HATS off): the union view of tabsFor — every adult
  // gets the authoring surfaces (the school-parent exception is a hat rule).
  authoring();
  if (f.board && role !== "parent") out.add("board");
  if (f.diary) out.add("diary");
  if (f.calendar) out.add("calendar");
  if (leader) leadership(role === "school_admin");
  else if (f.timetable) out.add("timetable");
  if (f.hasChildren || role === "parent") out.add("children");
  out.add("reports");
  return [...out];
}

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function cleanFilters(raw: Record<string, unknown> | undefined): NavFilters {
  const f: NavFilters = {};
  const s = (k: string) => (typeof raw?.[k] === "string" ? (raw[k] as string).trim() : "");
  if (ID_RE.test(s("classId"))) f.classId = s("classId");
  if (ID_RE.test(s("learnerId"))) f.learnerId = s("learnerId");
  if (DAY_RE.test(s("day"))) f.day = s("day");
  if (MONTH_RE.test(s("month"))) f.month = s("month");
  const topic = s("topic").slice(0, 80);
  if (topic) f.topic = topic;
  return f;
}

/** The path for a target the context may open (visibility already checked). */
export function navPath(target: NavTarget, filters: NavFilters, ctx: SkContext): { path: string; label: string } | { error: string } {
  const role = ctx.user.role;
  const hat = ctx.user.hat;
  const hasScope = ctx.user.coordinatorScope.length > 0;
  const leaderView = hat === "principal" || hat === "coordinator" || (hat === null && (role === "school_admin" || hasScope));
  const q = (pairs: Array<[string, string | undefined]>) => {
    const p = new URLSearchParams();
    for (const [k, v] of pairs) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const label = NAV_LABEL[target];
  switch (target) {
    case "library":
      return { path: "/dashboard", label: role === "student" ? "My lessons" : label };
    case "analytics":
      return { path: `/dashboard/analytics${q([["c", filters.classId]])}`, label };
    case "board":
      return { path: "/present", label };
    case "children":
      return { path: "/dashboard/children", label };
    case "school":
      return { path: "/dashboard/school", label };
    case "school_teachers":
      return { path: "/dashboard/school/teachers", label };
    case "school_access":
      return { path: "/dashboard/school/access", label };
    case "school_admin":
      return { path: "/dashboard/school/admin", label };
    case "school_books":
      return { path: "/dashboard/school/books", label };
    case "kits":
      return { path: `/dashboard/kits${q([["topic", filters.topic]])}`, label };
    case "diary":
      return { path: `/dashboard/diary${q([["d", filters.day], ["c", filters.classId]])}`, label };
    case "school_diary":
      return { path: `/dashboard/school/diary${q([["c", filters.classId], ["d", filters.day]])}`, label };
    case "timetable":
      return { path: leaderView ? "/dashboard/school/timetable" : "/dashboard/my-timetable", label };
    case "calendar":
      return { path: `/dashboard/calendar${q([["m", filters.month]])}`, label };
    case "tutor":
      return { path: "/sk", label };
    case "reports":
      if (!filters.learnerId) return { error: "needs_learner" };
      return { path: `/dashboard/reports/${encodeURIComponent(filters.learnerId)}`, label };
  }
}

export const NAV_REFUSED = "That page is not in your current view.";
export const NAV_NEEDS_LEARNER = "Which learner's progress record should I open?";

/** Pure core shared by the handler and the rules router's fast path. */
export function resolveNavigate(ctx: SkContext, args: Record<string, unknown>): SkCapabilityResult {
  const target = args.target;
  if (!isNavTarget(target)) return { ok: false, summary: "I don't know that page.", error: "unknown_target" };
  if (!navTargetsFor(ctx).includes(target)) return { ok: false, summary: NAV_REFUSED, error: "not_allowed" };
  const filters = cleanFilters(args);
  const r = navPath(target, filters, ctx);
  if ("error" in r) return { ok: false, summary: NAV_NEEDS_LEARNER, error: r.error };
  return { ok: true, summary: `Opening ${r.label}.`, navigate: r, facts: [] };
}

export const navigateCapability: SkCapability = {
  meta: {
    name: "navigate",
    description:
      "Open a portal page for the user (immediate, no confirmation). Use for 'open / show / take me to' requests. Filters: classId narrows analytics or a diary to one class, learnerId picks a progress record, topic filters the kits page, day (YYYY-MM-DD) opens a diary day, month (YYYY-MM) opens a calendar month. Pages the user's role cannot see are refused.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: [...NAV_TARGETS], description: "Which page to open." },
        classId: { type: "string", description: "A class id from context.resolve or the current selection." },
        learnerId: { type: "string", description: "A learner id (reports only)." },
        topic: { type: "string", description: "Topic filter for the kits page." },
        day: { type: "string", description: "YYYY-MM-DD (diary)." },
        month: { type: "string", description: "YYYY-MM (calendar)." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "nav",
    roles: ["teacher", "student", "parent", "school_admin", "coordinator"],
  },
  async handler(ctx, args) {
    return resolveNavigate(ctx, args);
  },
};
