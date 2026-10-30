// SK S7 K2 — knowledge.search: SK answers from the books, articles and
// uploads THIS user may use (design 2026-10-30; founder: completed books only).
//
// The order every search runs:
//   1. sourcesFor(ctx)            the user's allowed sources (sources.ts):
//                                 finals she has book access to, every
//                                 approved article, the uploads RLS shows her;
//   2. `source` / `restrict`      narrow THAT list (a title, a kind, or the
//                                 kit's own book) — never widen it; two
//                                 titles that fit → ask which;
//   3. sk_search_knowledge        with the ALLOWED sources only (the RPC
//                                 never decides access), service role;
//   4. every hit re-checked       against the allowed list before it becomes
//                                 a passage (a hit from a source not on it is
//                                 dropped), and only the passage fields are
//                                 copied — nothing else a row carries.
// The search is free (no model call). A student's knowledge ANSWER is one
// metered tutor turn (tutor.ts knowledgeForStudent → kit-turn.ts).
//
// The service-role client is made HERE, after the route's gate (as kit-server
// does for tutor.explain); handlers still receive only the session client.

import { createAdminClient } from "@/utils/supabase/admin";
import type { SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";
import { linesLocale, normalizeLanguage } from "@/sk/shell/language";
import { citationText, citeLine } from "@/sk/shell/knowledge-lines";
import { searchKnowledge, type KnowledgeHit } from "@/sk/knowledge/search";
import { ARTICLE_WILDCARD, rpcSources, sourcesFor, type KnowledgeSourceRef } from "@/sk/knowledge/sources";
import { citationsOf, passageText, sharedLanguage, type Passage } from "@/sk/knowledge/answer";
import { detectLanguage, normLanguage } from "@/sk/knowledge/text";
import type { KnowledgeDb, SourceKind } from "@/sk/knowledge/store";
import { resolveChild } from "./child-scope";

export const KNOWLEDGE_LIMIT = 6;

// ── the service-role seam ────────────────────────────────────────────────────

let adminOverride: (() => KnowledgeDb | null) | null = null;
/** Tests: the fake service-role client (null = none configured). */
export function __setKnowledgeAdminForTests(fn: (() => KnowledgeDb | null) | null): void {
  adminOverride = fn;
}
export function knowledgeAdmin(): KnowledgeDb | null {
  if (adminOverride) return adminOverride();
  try {
    return createAdminClient() as unknown as KnowledgeDb;
  } catch {
    return null;
  }
}

// ── choosing a source by name ────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const KIND_WORDS: Array<[RegExp, SourceKind]> = [
  [/^(?:sketchcast[_ ]?books?|sketchcast|bought books?|my bought books?|printed books?|buku sketchcast)$/u, "sketchcast_book"],
  [/^(?:articles?|the articles?|ready[- ]made|free articles?|artikel)$/u, "article"],
  [/^(?:user[_ ]?books?|uploads?|my uploads?|uploaded books?|my books?|buku saya)$/u, "user_book"],
];

export type SourcePick = { kind: "list"; list: KnowledgeSourceRef[] } | { kind: "ask"; candidates: KnowledgeSourceRef[] } | { kind: "none" };

/** A source named by kind or by title, among the ALLOWED sources only. */
export function pickSource(source: string, allowed: KnowledgeSourceRef[]): SourcePick {
  const q = fold(source);
  if (!q) return { kind: "list", list: allowed };
  for (const [re, kind] of KIND_WORDS) if (re.test(q) || q === kind) return { kind: "list", list: allowed.filter((s) => s.kind === kind) };
  const named = allowed.filter((s) => s.id !== ARTICLE_WILDCARD);
  const exact = named.filter((s) => fold(s.title) === q);
  const pool = exact.length ? exact : named.filter((s) => {
    const t = fold(s.title);
    return t.length >= 3 && (t.includes(q) || q.includes(t));
  });
  const distinct = [...new Map(pool.map((s) => [`${s.kind}:${s.id}`, s])).values()];
  if (!distinct.length) {
    // "the photosynthesis article": articles are searched by their text
    if (/\b(?:article|artikel)s?\b/u.test(q)) return { kind: "list", list: allowed.filter((s) => s.kind === "article") };
    return { kind: "none" };
  }
  if (distinct.length > 1 && new Set(distinct.map((s) => fold(s.title))).size > 1) return { kind: "ask", candidates: distinct.slice(0, 5) };
  return { kind: "list", list: distinct };
}

/** `restrict` cut to what `all` allows (articles: the wildcard allows any). */
export function within(restrict: KnowledgeSourceRef[], all: KnowledgeSourceRef[]): KnowledgeSourceRef[] {
  const anyArticle = all.some((s) => s.kind === "article");
  const out: KnowledgeSourceRef[] = [];
  for (const r of restrict) {
    if (r.kind === "article") {
      if (anyArticle) out.push(r);
      continue;
    }
    const hit = all.find((s) => s.kind === r.kind && s.id === r.id);
    if (hit) out.push(hit);
  }
  return out;
}

/** Is this hit from a source on the list (and, when pinned, its version)? */
export function hitAllowed(h: Pick<KnowledgeHit, "source_kind" | "source_id" | "version">, allowed: KnowledgeSourceRef[]): boolean {
  return allowed.some(
    (s) =>
      s.kind === h.source_kind &&
      (s.id === ARTICLE_WILDCARD ? s.kind === "article" : s.id === String(h.source_id)) &&
      (!s.version || s.version === String(h.version)),
  );
}

// ── the search ───────────────────────────────────────────────────────────────

export type KnowledgeSearchInput = {
  query: string;
  /** A title or a kind, chosen among her allowed sources. */
  source?: string;
  chapter?: number | null;
  /** Search only these (the kit's own book / article), cut to what she may use. */
  restrict?: KnowledgeSourceRef[];
  limit?: number;
  /** A parent asking for one of her verified children. */
  forChildId?: string | null;
};

export type KnowledgeSearchOutcome =
  | { status: "ok"; passages: Passage[]; searched: KnowledgeSourceRef[]; all: KnowledgeSourceRef[] }
  | { status: "ask"; candidates: KnowledgeSourceRef[] }
  | { status: "no_source"; source: string }
  | { status: "error"; message: string };

type ArticleMeta = { id: string; title: string | null; language: string | null };

async function articleMeta(admin: KnowledgeDb, ids: string[]): Promise<Map<string, ArticleMeta>> {
  const out = new Map<string, ArticleMeta>();
  if (!ids.length) return out;
  const { data, error } = await admin.from("topic_articles").select("id, title, language").in("id", ids);
  if (error) console.error("[sk knowledge] article titles:", error.message);
  for (const a of (data ?? []) as ArticleMeta[]) out.set(String(a.id), a);
  return out;
}

/** Hits → passages: only allowed sources, only the passage fields. */
async function toPassages(admin: KnowledgeDb, hits: KnowledgeHit[], allowed: KnowledgeSourceRef[]): Promise<Passage[]> {
  const kept = hits.filter((h) => hitAllowed(h, allowed));
  const arts = await articleMeta(admin, [...new Set(kept.filter((h) => h.source_kind === "article").map((h) => String(h.source_id)))]);
  return kept
    .map((h): Passage | null => {
      const text = passageText(h.text);
      if (!text) return null;
      const ref = allowed.find((s) => s.kind === h.source_kind && s.id === String(h.source_id));
      const art = h.source_kind === "article" ? arts.get(String(h.source_id)) : undefined;
      const section = passageText(h.title).slice(0, 200);
      const title = (ref?.title || art?.title || section || "").trim().slice(0, 200);
      const guessed = detectLanguage(text) === "ar" ? "ar" : null; // only Arabic script is a safe guess
      return {
        kind: h.source_kind,
        source_id: String(h.source_id),
        source_title: title,
        chapter: h.chapter == null ? null : Number(h.chapter),
        anchor: String(h.anchor ?? "").slice(0, 200),
        section,
        text,
        language: ref?.language ?? normLanguage(art?.language) ?? guessed,
      };
    })
    .filter((p): p is Passage => !!p);
}

/** The search for one user (the capability, the tutor and the Board use it). */
export async function searchForUser(ctx: SkContext, deps: SkCapabilityDeps, input: KnowledgeSearchInput): Promise<KnowledgeSearchOutcome> {
  const query = (input.query ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!query) return { status: "ok", passages: [], searched: [], all: [] };
  const admin = knowledgeAdmin();
  if (!admin) return { status: "error", message: "knowledge search unavailable" };
  const all = await sourcesFor(ctx, admin, deps, { forChildId: input.forChildId ?? null });
  let allowed = input.restrict ? within(input.restrict, all) : all;
  if (input.source?.trim()) {
    const pick = pickSource(input.source, allowed);
    if (pick.kind === "ask") return { status: "ask", candidates: pick.candidates };
    if (pick.kind === "none") return { status: "no_source", source: input.source.trim().slice(0, 80) };
    allowed = pick.list;
  }
  if (!allowed.length) return { status: "ok", passages: [], searched: [], all };
  const lang = ctx.answer?.lang ?? ctx.user.locale ?? "en";
  const r = await searchKnowledge(admin, { query, lang, sources: rpcSources(allowed), chapter: input.chapter ?? null, limit: input.limit ?? KNOWLEDGE_LIMIT });
  if (r.status === "error") return { status: "error", message: r.message };
  return { status: "ok", passages: await toPassages(admin, r.hits, allowed), searched: allowed, all };
}

// ── results ──────────────────────────────────────────────────────────────────

/** The locale a citation is written in: the passages' one language, else hers. */
export function citeLocale(ctx: SkContext, passages: Passage[]): string {
  const shared = normalizeLanguage(sharedLanguage(passages));
  return typeof shared === "string" ? linesLocale(shared) : ctx.user.locale;
}

/** Passages as a capability result: facts (passage fields only), citations,
 *  and the source language when every passage shares one. */
export function passagesResult(ctx: SkContext, query: string, passages: Passage[]): SkCapabilityResult {
  if (!passages.length) return { ok: true, summary: `Nothing in your books, articles or uploads matches '${query}'.`, facts: [] };
  const locale = citeLocale(ctx, passages);
  const language = sharedLanguage(passages);
  const titles = [...new Set(passages.map((p) => p.source_title))].slice(0, 3);
  const cite = citeLine(passages.map((p) => ({ title: p.source_title, chapter: p.chapter, section: p.section })), locale);
  return {
    ok: true,
    summary: `${passages.length} passage${passages.length === 1 ? "" : "s"} for '${query}' from ${titles.join("; ")}. Answer only from them; end with: ${cite}`.slice(0, 400),
    facts: passages.map((p) => ({
      kind: p.kind,
      source_title: p.source_title,
      chapter: p.chapter,
      anchor: p.anchor,
      section: p.section,
      passage: p.text,
      language: p.language,
      cite: citationText({ title: p.source_title, chapter: p.chapter, section: p.section }, locale),
    })),
    citations: citationsOf(passages),
    ...(language ? { language } : {}),
  };
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

/** A parent naming a child (or on that child's page) searches with that
 *  child's books too — a VERIFIED child only (child-scope.ts). */
function childFor(ctx: SkContext, arg: unknown): string | null {
  if (ctx.user.role !== "parent") return null;
  const scope = resolveChild(ctx, arg);
  return scope.kind === "children" && scope.children.length === 1 ? scope.children[0].id : null;
}

export const knowledgeSearch: SkCapability = {
  meta: {
    name: "knowledge.search",
    description:
      "Search the passages of the books, articles and uploads this user may read (SketchCast books she has access to, the free ready-made articles, her own and her school shelf's uploads) for a content question: 'what is…', 'explain…', 'why…'. Returns passages with their source, chapter and section. source = a book title or 'articles' / 'uploads' to narrow; chapter = a chapter number.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question's subject words, e.g. 'specialised cells' or 'photosynthesis light'." },
        source: { type: "string", description: "Optional: a book title, or 'sketchcast books' | 'articles' | 'uploads'." },
        chapter: { type: "integer", minimum: 0, description: "Optional chapter number within that source." },
        child: { type: "string", description: "Parent only: the child the question is for (name), so that child's books count too." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "student", "parent", "school_admin", "coordinator"],
    flags: ["sk"],
  },
  async handler(ctx, args, deps) {
    const query = str(args.query);
    if (!query) return { ok: false, summary: "I need a word or two to look up.", error: "query required" };
    try {
      const r = await searchForUser(ctx, deps, { query, source: str(args.source, 120) || undefined, chapter: intOrNull(args.chapter), forChildId: childFor(ctx, args.child) });
      if (r.status === "error") return { ok: false, summary: "I could not search your books right now.", error: r.message };
      if (r.status === "no_source") return { ok: false, summary: `You have no book, article or upload called '${r.source}' that I can read.`, error: "no_source", facts: [] };
      if (r.status === "ask") {
        return {
          ok: true,
          summary: `More than one of your sources fits '${str(args.source, 80)}': ${r.candidates.map((c) => c.title).join("; ")}. Ask which one.`.slice(0, 400),
          facts: r.candidates.map((c) => ({ ask: "which_source", title: c.title, kind: c.kind })),
        };
      }
      return passagesResult(ctx, query, r.passages);
    } catch (e) {
      return { ok: false, summary: "I could not search your books right now.", error: e instanceof Error ? e.message : String(e) };
    }
  },
};
