// S4 — which child a parent's question is about (design 2026-10-29,
// decisions 5 and 6). PURE: the only source of children is ctx.children, which
// loadContext built from the parent's OWN parent_links through the session
// client. Nothing the client or the model sends can add a child:
//   - an id is matched against ctx.children ONLY; any other id is refused;
//   - a name is matched against ctx.children ONLY; two plausible matches ask;
//   - no child named + 2 or more children → ALL of them, so the capability
//     answers once per child ("how are my kids doing");
//   - an UNVERIFIED link is never answered about (decision 5).

import type { SkChild, SkContext } from "@/sk/shell/types";

export type ChildScope =
  | { kind: "children"; children: SkChild[] }
  | { kind: "ask"; candidates: SkChild[] }
  | { kind: "unverified"; child: SkChild }
  | { kind: "refused"; reason: "not_linked" | "no_children" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "my kids", "both", "all of them", "anak-anak saya", "أطفالي" — everyone. */
const ALL_RE = /^(?:all|both|everyone|each|my (?:kids|children)|the (?:kids|children)|kids|children|all (?:of )?(?:them|my (?:kids|children))|both of them|semua|kedua-dua(?:nya)?|anak-anak(?: saya)?|semua anak(?: saya)?|أطفالي|أولادي|الجميع|كلهم|كلاهما)$/u;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’]s$/u, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The verified children (the only ones SK reads about). */
export function verifiedChildren(ctx: SkContext): SkChild[] {
  return (ctx.children ?? []).filter((c) => c.verified);
}

/** Is this id one of the parent's VERIFIED children? The gate in front of every
 *  admin read (child.progress) — a second check, after resolveChild. */
export function isVerifiedChild(ctx: SkContext, childId: string): boolean {
  return verifiedChildren(ctx).some((c) => c.id === childId);
}

export function resolveChild(ctx: SkContext, arg: unknown): ChildScope {
  const all = ctx.children ?? [];
  const verified = all.filter((c) => c.verified);
  const raw = typeof arg === "string" ? arg.trim().slice(0, 120) : "";

  if (!raw) {
    // The page the parent is on may name a child (/dashboard/reports/<id>).
    const sel = ctx.selection.learnerId;
    const onPage = sel ? verified.find((c) => c.id === sel) : undefined;
    if (onPage) return { kind: "children", children: [onPage] };
    if (verified.length) return { kind: "children", children: verified };
    if (all.length) return { kind: "unverified", child: all[0] };
    return { kind: "refused", reason: "no_children" };
  }

  if (UUID_RE.test(raw)) {
    const hit = all.find((c) => c.id.toLowerCase() === raw.toLowerCase());
    if (!hit) return { kind: "refused", reason: "not_linked" };
    return hit.verified ? { kind: "children", children: [hit] } : { kind: "unverified", child: hit };
  }

  const q = fold(raw);
  if (!q) return verified.length ? { kind: "children", children: verified } : { kind: "refused", reason: "no_children" };
  if (ALL_RE.test(q)) {
    if (verified.length) return { kind: "children", children: verified };
    return all.length ? { kind: "unverified", child: all[0] } : { kind: "refused", reason: "no_children" };
  }

  // Exact full name, then exact first name, then a word of the name starting
  // with what was said ("Ais" → Aisyah). The first tier with hits decides.
  const tiers: Array<(c: SkChild) => boolean> = [
    (c) => fold(c.name) === q,
    (c) => fold(c.firstName) === q,
    (c) => q.length >= 3 && fold(c.name).split(" ").some((w) => w.startsWith(q)),
  ];
  for (const test of tiers) {
    const hits = all.filter(test);
    if (!hits.length) continue;
    if (hits.length > 1) return { kind: "ask", candidates: hits };
    return hits[0].verified ? { kind: "children", children: [hits[0]] } : { kind: "unverified", child: hits[0] };
  }
  return { kind: "refused", reason: "not_linked" };
}
