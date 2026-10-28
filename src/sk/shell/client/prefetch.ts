// Which portal pages the SK panel warms up (router.prefetch) so a `navigate`
// lands on a page whose server render is already on its way (founder,
// 2026-10-28: "the navigation between pages should feel seamless"). Pure:
// the panel passes the role, the hat and the capability names the server
// returned, and a Set of what it has already asked for; this returns the
// paths to prefetch NOW and marks them, so a `meta` event on every turn does
// not re-prefetch the same pages.
//
// The list is a small fixed one, per role/hat, mirroring the targets
// navigate.ts can resolve for that view (navTargetsFor). It is only a hint to
// the router: a page the role cannot see is never prefetched, and a page that
// IS prefetched but refused server-side is simply never navigated to.
// Nothing is prefetched until the server has named `navigate` among the
// capabilities — a panel that cannot navigate has nothing to warm.

export const PREFETCH_PATHS = {
  library: "/dashboard",
  analytics: "/dashboard/analytics",
  board: "/present",
  kits: "/dashboard/kits",
  diary: "/dashboard/diary",
  timetable: "/dashboard/my-timetable",
  calendar: "/dashboard/calendar",
  children: "/dashboard/children",
} as const;

export type PrefetchInput = {
  role: string | null;
  hat: string | null;
  /** Capability names from the context GET or the turn's `meta` event. */
  capabilities: readonly string[];
  /** Paths already requested in this panel's life; mutated. */
  done: Set<string>;
};

/** The paths a role/hat may be sent to by `navigate`, in a stable order. */
export function prefetchTargets(role: string | null, hat: string | null): string[] {
  const P = PREFETCH_PATHS;
  const r = (role ?? "").toLowerCase();
  if (r === "student") return [P.library, P.diary, P.timetable];
  if (hat === "parent" || (hat === null && r === "parent")) return [P.library, P.children, P.diary, P.calendar];
  if (hat === "principal" || hat === "coordinator") return [P.calendar];
  // teacher hat, or an adult with hats off (the union view)
  return [P.library, P.analytics, P.board, P.kits, P.diary, P.timetable, P.calendar];
}

/** The paths to prefetch now: the role's targets not yet requested. Empty
 *  until `navigate` is among the capabilities. Marks what it returns. */
export function pathsToPrefetch(input: PrefetchInput): string[] {
  if (!input.capabilities.includes("navigate")) return [];
  const out: string[] = [];
  for (const path of prefetchTargets(input.role, input.hat)) {
    if (input.done.has(path)) continue;
    input.done.add(path);
    out.push(path);
  }
  return out;
}
