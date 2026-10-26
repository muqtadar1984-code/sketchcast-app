// SK B1 — export one study-guide chapter draft into the SK book-content tables.
//
//   npx tsx tools/sk/export-chapter.ts <path/to/chNN-draft.json> [options]
//
// Options
//   --emit-sql <file>        write ONE SQL transaction instead of touching a
//                            database (no env needed); apply it with the
//                            Supabase SQL editor / MCP / psql. This is how the
//                            Chapter 2 export was applied to the sk-b1 branch.
//   --dry-run                resolve everything and print the plan; write nothing
//   --topic <canonical_key>  the catalogue topic whose bank the exercises join
//                            (default: derived from the chapter title)
//   --manuscript-version <v> stored on sk_book_products (default: ch<N>-draft@<sha7 of the file>)
//
// Direct mode needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — point them at
// a BRANCH database. Nothing here should ever run against production without
// the founder's separate approval (docs/SK-B1-REPORT.md).
//
// What it writes (see export-lib.ts for the rules):
//   sk_book_products (upsert on slug) → sk_book_units (upsert) → teaching_objectives
//   (insert; an existing DRAFT is overwritten, a VALIDATED one is never touched)
//   → objective_curriculum_map (proposed rows for cited codes that exist; a
//   row a human has reviewed is never touched) → sk_book_blocks (replaced for
//   the chapter) → exercises: ONLY if the chapter's catalogue topic and its
//   approved English article exist, bank items the exercises were seeded from
//   are STAMPED with the unit's teaching_objective_id and the rest are inserted
//   as draft book items; otherwise exercises are skipped and reported.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildExport,
  type ChapterDraft,
  type ExportPlan,
  type Lookups,
  PRODUCT_SLUG,
} from "./export-lib";

// ── args ────────────────────────────────────────────────────────────────────

type Args = { draftPath: string; emitSql: string | null; dryRun: boolean; topic: string | null; manuscriptVersion: string | null };

function parseArgs(argv: string[]): Args {
  const a: Args = { draftPath: "", emitSql: null, dryRun: false, topic: null, manuscriptVersion: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--emit-sql") a.emitSql = argv[++i] ?? "";
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--topic") a.topic = argv[++i] ?? null;
    else if (x === "--manuscript-version") a.manuscriptVersion = argv[++i] ?? null;
    else if (!a.draftPath) a.draftPath = x;
    else throw new Error(`unexpected argument ${x}`);
  }
  if (!a.draftPath) throw new Error("usage: npx tsx tools/sk/export-chapter.ts <chNN-draft.json> [--emit-sql out.sql | --dry-run] [--topic key] [--manuscript-version v]");
  return a;
}

// ── topic lookup keys ───────────────────────────────────────────────────────

/** "Seeing Cells: Microscopes and Magnification" → "seeing_cells_microscopes_and_magnification" */
export function canonicalKeyFromTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The catalogue topic that holds this chapter's bank: Chapter 2 of the Cells book was authored from this topic. */
const CHAPTER_TOPICS: Record<string, Record<number, string>> = {
  [PRODUCT_SLUG]: { 2: "using_a_microscope_and_calculating_magnification" },
};

function topicKeys(draft: ChapterDraft, override: string | null): { canonical_key: string; slug: string; title: string } {
  const key = override ?? CHAPTER_TOPICS[draft.work?.slug ?? PRODUCT_SLUG]?.[draft.chapter.number] ?? canonicalKeyFromTitle(draft.chapter.title);
  return { canonical_key: key, slug: key.replace(/_/g, "-"), title: draft.chapter.title };
}

// ── SQL rendering ───────────────────────────────────────────────────────────

const lit = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;
const jsonb = (v: unknown): string => `${lit(JSON.stringify(v))}::jsonb`;
const textArray = (xs: string[]): string => (xs.length ? `array[${xs.map((x) => lit(x)).join(",")}]::text[]` : "'{}'::text[]");

/** One transaction that performs the whole export; the last statement returns a JSON summary. */
export function renderSql(plan: ExportPlan, topic: { canonical_key: string; slug: string; title: string }): string {
  const S = lit(plan.product.slug);
  const C = plan.chapter;
  const obj = (unitKey: string) =>
    `(select o.id from public.teaching_objectives o join public.sk_book_products p on p.id = o.product_id where p.slug = ${S} and o.chapter = ${C} and o.unit_key = ${lit(unitKey)})`;
  const topicWhere = `(t.canonical_key = ${lit(topic.canonical_key)} or t.slug = ${lit(topic.slug)} or lower(t.title) = lower(${lit(topic.title)}))`;
  const out: string[] = [];
  out.push(`-- SK B1 chapter export: ${plan.product.slug} chapter ${C} (generated by tools/sk/export-chapter.ts; do not edit)`);
  out.push("begin;");
  out.push(
    `insert into public.sk_book_products (slug, title, subject, curriculum_id, languages, status, manuscript_version)\n` +
      `values (${S}, ${lit(plan.product.title)}, ${lit(plan.product.subject)}, (select id from public.curricula where code = ${lit(plan.product.curriculum_code)}), ${textArray(plan.product.languages)}, 'draft', ${lit(plan.product.manuscript_version)})\n` +
      `on conflict (slug) do update set title = excluded.title, subject = excluded.subject, curriculum_id = coalesce(excluded.curriculum_id, public.sk_book_products.curriculum_id), manuscript_version = excluded.manuscript_version;`,
  );
  for (const u of plan.units) {
    out.push(
      `insert into public.sk_book_units (product_id, chapter, unit_key, section_sid, title, sort_order, node_codes)\n` +
        `select p.id, ${C}, ${lit(u.unit_key)}, ${lit(u.section_sid)}, ${lit(u.title)}, ${u.sort_order}, ${textArray(u.node_codes)} from public.sk_book_products p where p.slug = ${S}\n` +
        `on conflict (product_id, chapter, unit_key) do update set section_sid = excluded.section_sid, title = excluded.title, sort_order = excluded.sort_order, node_codes = excluded.node_codes;`,
    );
  }
  for (const o of plan.objectives) {
    out.push(
      `insert into public.teaching_objectives (product_id, chapter, unit_key, text)\n` +
        `select p.id, ${C}, ${lit(o.unit_key)}, ${lit(o.text)} from public.sk_book_products p where p.slug = ${S}\n` +
        `on conflict (product_id, chapter, unit_key) do update set text = excluded.text where public.teaching_objectives.status = 'draft';`,
    );
  }
  // maps: one proposed row per cited code that EXISTS; the join drops unknown codes (reported in the summary)
  for (const u of plan.units) {
    for (const code of u.node_codes) {
      out.push(
        `insert into public.objective_curriculum_map (teaching_objective_id, curriculum_node_id, relation, map_confidence, mapped_by, status, notes)\n` +
          `select o.id, n.id, 'supports', 0.5, 'model', 'proposed', ${lit(`proposed by tools/sk/export-chapter.ts from the manuscript plan (section ${u.section_sid} cites ${code})`)}\n` +
          `from public.sk_book_products p\n` +
          `join public.teaching_objectives o on o.product_id = p.id and o.chapter = ${C} and o.unit_key = ${lit(u.unit_key)}\n` +
          `join public.curriculum_nodes n on n.curriculum_id = p.curriculum_id and n.code = ${lit(code)}\n` +
          `where p.slug = ${S}\n` +
          `on conflict (teaching_objective_id, curriculum_node_id) do nothing;`,
      );
    }
  }
  out.push(`delete from public.sk_book_blocks b using public.sk_book_products p where b.product_id = p.id and p.slug = ${S} and b.chapter = ${C};`);
  if (plan.blocks.length) {
    const rows = plan.blocks.map((b) => `(${lit(b.section_sid)}, ${b.block_index}, ${lit(b.block_type)}, ${jsonb(b.body)}, ${textArray(b.source_refs)}, ${lit(b.unit_key)})`);
    out.push(
      `insert into public.sk_book_blocks (product_id, chapter, section_sid, block_index, block_type, body, source_refs, unit_key)\n` +
        `select p.id, ${C}, v.section_sid, v.block_index, v.block_type, v.body, v.source_refs, v.unit_key\n` +
        `from public.sk_book_products p, (values\n  ${rows.join(",\n  ")}\n) as v(section_sid, block_index, block_type, body, source_refs, unit_key)\nwhere p.slug = ${S};`,
    );
  }
  // exercises — only where the chapter's topic and its approved English article exist
  const stampIds: string[] = [];
  for (const e of plan.exercises) {
    const objective = e.unit_key ? obj(e.unit_key) : "NULL";
    if (e.source_item_id) {
      stampIds.push(e.source_item_id);
      out.push(`update public.topic_questions q set teaching_objective_id = ${objective} where q.id = ${lit(e.source_item_id)};`);
    }
    const r = e.row;
    out.push(
      `insert into public.topic_questions (topic_id, article_id, language, item_type, answer_mode, difficulty, cognitive_level, marks, stem, options, answer, marking_scheme, explanation, tags, content_hash, status, notes, teaching_objective_id)\n` +
        `select t.id, a.id, 'en', ${lit(r.item_type)}, ${lit(r.answer_mode)}, ${r.difficulty}, ${lit(r.cognitive_level)}, ${r.marks}, ${lit(r.stem)}, ${r.options === null ? "NULL" : jsonb(r.options)}, ${jsonb(r.answer)}, ${r.marking_scheme === null ? "NULL" : jsonb(r.marking_scheme)}, ${lit(r.explanation)}, ${textArray(r.tags)}, ${lit(r.content_hash)}, 'draft', ${lit(r.notes)}, ${objective}\n` +
        `from public.topics t join public.topic_articles a on a.topic_id = t.id and a.language = 'en' and a.status = 'approved'\n` +
        `where ${topicWhere}` +
        (e.source_item_id ? `\n  and not exists (select 1 from public.topic_questions x where x.id = ${lit(e.source_item_id)})` : "") +
        `\non conflict (topic_id, language, content_hash) do update set teaching_objective_id = excluded.teaching_objective_id;`,
    );
  }
  out.push("commit;");
  const allCodes = [...new Set(plan.units.flatMap((u) => u.node_codes))];
  out.push(
    `select jsonb_build_object(\n` +
      `  'product_id', (select id from public.sk_book_products where slug = ${S}),\n` +
      `  'units', (select count(*) from public.sk_book_units u join public.sk_book_products p on p.id = u.product_id where p.slug = ${S} and u.chapter = ${C}),\n` +
      `  'objectives', (select count(*) from public.teaching_objectives o join public.sk_book_products p on p.id = o.product_id where p.slug = ${S} and o.chapter = ${C}),\n` +
      `  'maps', (select count(*) from public.objective_curriculum_map m join public.teaching_objectives o on o.id = m.teaching_objective_id join public.sk_book_products p on p.id = o.product_id where p.slug = ${S} and o.chapter = ${C}),\n` +
      `  'blocks', (select count(*) from public.sk_book_blocks b join public.sk_book_products p on p.id = b.product_id where p.slug = ${S} and b.chapter = ${C}),\n` +
      `  'missing_codes', (select coalesce(jsonb_agg(c.code), '[]'::jsonb) from (values ${allCodes.length ? allCodes.map((c) => `(${lit(c)})`).join(",") : "(NULL::text)"}) as c(code) where c.code is not null and not exists (select 1 from public.curriculum_nodes n join public.sk_book_products p on p.curriculum_id = n.curriculum_id where p.slug = ${S} and n.code = c.code)),\n` +
      `  'topic_found', exists (select 1 from public.topics t join public.topic_articles a on a.topic_id = t.id and a.language = 'en' and a.status = 'approved' where ${topicWhere}),\n` +
      `  'stamped', (select count(*) from public.topic_questions q where q.teaching_objective_id is not null and q.id in (${stampIds.length ? stampIds.map((id) => lit(id)).join(",") : "NULL::uuid"})),\n` +
      `  'inserted', (select count(*) from public.topic_questions q where ${lit(`book:${plan.product.slug}`)} = any (q.tags) and ${lit(`ch:${C}`)} = any (q.tags))\n` +
      `) as summary;`,
  );
  return out.join("\n\n") + "\n";
}

// ── direct mode (supabase-js, service role) ─────────────────────────────────

async function fetchLookups(db: SupabaseClient, draft: ChapterDraft, curriculumCode: string | null): Promise<Lookups & { curriculumId: string | null }> {
  const codes = [...new Set(draft.plan.sections.flatMap((s) => s.node_codes ?? []))];
  let curriculumId: string | null = null;
  const nodesByCode = new Map<string, string>();
  if (curriculumCode) {
    const { data: cur, error } = await db.from("curricula").select("id").eq("code", curriculumCode).maybeSingle();
    if (error) throw error;
    curriculumId = cur?.id ?? null;
    if (curriculumId && codes.length) {
      const { data: nodes, error: e2 } = await db.from("curriculum_nodes").select("id, code").eq("curriculum_id", curriculumId).in("code", codes);
      if (e2) throw e2;
      for (const n of nodes ?? []) nodesByCode.set(n.code, n.id);
    }
  }
  const sourceIds = draft.exercises.map((e) => /^item:([0-9a-f-]{36})$/i.exec(e.source_item_id ?? "")?.[1]?.toLowerCase()).filter((x): x is string => !!x);
  const existingQuestionIds = new Set<string>();
  if (sourceIds.length) {
    const { data: qs, error } = await db.from("topic_questions").select("id").in("id", sourceIds);
    if (error) throw error;
    for (const q of qs ?? []) existingQuestionIds.add(q.id);
  }
  return { nodesByCode, existingQuestionIds, curriculumId };
}

async function applyDirect(db: SupabaseClient, plan: ExportPlan, curriculumId: string | null, topic: { canonical_key: string; slug: string; title: string }) {
  const C = plan.chapter;
  const { data: product, error: pe } = await db
    .from("sk_book_products")
    .upsert(
      { slug: plan.product.slug, title: plan.product.title, subject: plan.product.subject, curriculum_id: curriculumId, languages: plan.product.languages, manuscript_version: plan.product.manuscript_version },
      { onConflict: "slug" },
    )
    .select("id")
    .single();
  if (pe) throw pe;
  const pid = product.id as string;

  const { error: ue } = await db
    .from("sk_book_units")
    .upsert(plan.units.map((u) => ({ product_id: pid, chapter: C, unit_key: u.unit_key, section_sid: u.section_sid, title: u.title, sort_order: u.sort_order, node_codes: u.node_codes })), { onConflict: "product_id,chapter,unit_key" });
  if (ue) throw ue;

  // objectives: never overwrite a validated one
  const { data: existing, error: oe } = await db.from("teaching_objectives").select("id, unit_key, status").eq("product_id", pid).eq("chapter", C);
  if (oe) throw oe;
  const byUnit = new Map((existing ?? []).map((o) => [o.unit_key as string, o]));
  for (const o of plan.objectives) {
    const cur = byUnit.get(o.unit_key);
    if (!cur) {
      const { error } = await db.from("teaching_objectives").insert({ product_id: pid, chapter: C, unit_key: o.unit_key, text: o.text });
      if (error) throw error;
    } else if (cur.status === "draft") {
      const { error } = await db.from("teaching_objectives").update({ text: o.text }).eq("id", cur.id);
      if (error) throw error;
    }
  }
  const { data: objectives, error: oe2 } = await db.from("teaching_objectives").select("id, unit_key").eq("product_id", pid).eq("chapter", C);
  if (oe2) throw oe2;
  const objectiveId = new Map((objectives ?? []).map((o) => [o.unit_key as string, o.id as string]));

  if (plan.maps.length) {
    const { error } = await db.from("objective_curriculum_map").upsert(
      plan.maps.map((m) => ({ teaching_objective_id: objectiveId.get(m.unit_key), curriculum_node_id: m.curriculum_node_id, relation: m.relation, map_confidence: m.map_confidence, mapped_by: "model", status: "proposed", notes: `proposed by tools/sk/export-chapter.ts from the manuscript plan (${m.code})` })),
      { onConflict: "teaching_objective_id,curriculum_node_id", ignoreDuplicates: true },
    );
    if (error) throw error;
  }

  const { error: de } = await db.from("sk_book_blocks").delete().eq("product_id", pid).eq("chapter", C);
  if (de) throw de;
  if (plan.blocks.length) {
    const { error } = await db.from("sk_book_blocks").insert(plan.blocks.map((b) => ({ product_id: pid, chapter: C, ...b })));
    if (error) throw error;
  }

  // exercises
  const { data: topics, error: te } = await db.from("topics").select("id, canonical_key, slug, title").or(`canonical_key.eq.${topic.canonical_key},slug.eq.${topic.slug},title.ilike.${topic.title}`).limit(1);
  if (te) throw te;
  const topicRow = topics?.[0] ?? null;
  let articleId: string | null = null;
  if (topicRow) {
    const { data: art, error } = await db.from("topic_articles").select("id").eq("topic_id", topicRow.id).eq("language", "en").eq("status", "approved").maybeSingle();
    if (error) throw error;
    articleId = art?.id ?? null;
  }
  let stamped = 0;
  let inserted = 0;
  if (topicRow && articleId) {
    for (const e of plan.exercises) {
      const toid = e.unit_key ? (objectiveId.get(e.unit_key) ?? null) : null;
      if (e.action === "stamp" && e.source_item_id) {
        const { error } = await db.from("topic_questions").update({ teaching_objective_id: toid }).eq("id", e.source_item_id);
        if (error) throw error;
        stamped++;
      } else {
        const { error } = await db
          .from("topic_questions")
          .upsert({ topic_id: topicRow.id, article_id: articleId, language: "en", status: "draft", teaching_objective_id: toid, ...e.row }, { onConflict: "topic_id,language,content_hash" });
        if (error) throw error;
        inserted++;
      }
    }
  }
  return { product_id: pid, topic_found: !!(topicRow && articleId), stamped, inserted };
}

// ── main ────────────────────────────────────────────────────────────────────

function printPlan(plan: ExportPlan, resolvedAtApply = false) {
  const cited = [...new Set(plan.units.flatMap((u) => u.node_codes))];
  const seeded = plan.exercises.filter((e) => e.source_item_id).length;
  const lines = [
    `product ${plan.product.slug} chapter ${plan.chapter} (${plan.product.manuscript_version ?? "no version"})`,
    `units ${plan.units.length}: ${plan.units.map((u) => `${u.unit_key}=${u.section_sid} "${u.title}"`).join("; ")}`,
    `objectives ${plan.objectives.length}`,
    ...plan.objectives.map((o) => `  ${o.unit_key}: ${o.text}`),
    resolvedAtApply
      ? `maps: one proposed row (supports, 0.5) per cited code that exists when the SQL runs — cited: ${cited.join(", ") || "none"}`
      : `maps ${plan.maps.length} proposed (supports, 0.5)` + (plan.missingCodes.length ? `; SKIPPED unknown codes: ${plan.missingCodes.map((m) => `${m.unit_key}:${m.code}`).join(", ")}` : ""),
    `blocks ${plan.blocks.length}`,
    resolvedAtApply
      ? `exercises ${plan.exercises.length}: ${seeded} were seeded from bank items (stamped if the item exists, else inserted), ${plan.exercises.length - seeded} inserted` +
        (plan.exercises.some((e) => !e.unit_key) ? ` (unassigned: ${plan.exercises.filter((e) => !e.unit_key).map((e) => e.xid).join(", ")})` : "")
      : `exercises ${plan.exercises.length}: ${plan.exercises.filter((e) => e.action === "stamp").length} stamp existing bank items, ${plan.exercises.filter((e) => e.action === "insert").length} insert` +
        (plan.exercises.some((e) => !e.unit_key) ? ` (unassigned: ${plan.exercises.filter((e) => !e.unit_key).map((e) => e.xid).join(", ")})` : ""),
    ...plan.exercises.map((e) => `  ${e.xid} ${e.item_type} → ${e.unit_key ?? "—"} (${resolvedAtApply && e.source_item_id ? "stamp-or-insert" : e.action}${e.source_item_id ? " " + e.source_item_id : ""})`),
    `auto-markable per unit (need ≥ ${3}):`,
    ...plan.shortfall.map((s) => `  ${s.unit_key}: ${s.auto_markable} [${s.xids.join(", ")}]` + (s.needed ? ` — short by ${s.needed}` : "")),
  ];
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = readFileSync(args.draftPath, "utf8");
  const draft = JSON.parse(raw) as ChapterDraft;
  if (!draft?.chapter?.number || !Array.isArray(draft?.plan?.sections) || !Array.isArray(draft?.sections)) {
    throw new Error(`${args.draftPath} is not a chapter draft (needs chapter.number, plan.sections, sections)`);
  }
  const version = args.manuscriptVersion ?? `${basename(args.draftPath).replace(/\.json$/, "")}@${createHash("sha1").update(raw).digest("hex").slice(0, 7)}`;
  const topic = topicKeys(draft, args.topic);

  if (args.emitSql !== null || args.dryRun) {
    // No database in reach: codes and bank items resolve inside the SQL itself.
    const plan = buildExport(draft, { nodesByCode: new Map(), existingQuestionIds: new Set() }, version);
    printPlan(plan, true);
    if (args.emitSql) {
      writeFileSync(args.emitSql, renderSql(plan, topic), "utf8");
      console.log(`\nSQL written to ${args.emitSql} (codes and existing bank items are resolved when it runs; its last statement returns the counts)`);
    }
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (point them at a BRANCH database), or use --emit-sql / --dry-run");
  if (/pblaxsqhjwlqbrwbraxy/.test(url) && process.env.SK_ALLOW_PRODUCTION !== "1") {
    throw new Error("refusing to run against the production project; set SK_ALLOW_PRODUCTION=1 only with the founder's approval");
  }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const lookups = await fetchLookups(db, draft, draft.work?.curriculum ?? null);
  const plan = buildExport(draft, lookups, version);
  printPlan(plan);
  const result = await applyDirect(db, plan, lookups.curriculumId, topic);
  console.log(`\napplied: ${JSON.stringify(result)}`);
  if (!result.topic_found) console.log(`exercises NOT imported: no topic with an approved English article matched ${JSON.stringify(topic)}`);
}

const isCli = process.argv[1] !== undefined && /export-chapter\.(ts|js|mts|mjs)$/.test(process.argv[1]);
if (isCli) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
