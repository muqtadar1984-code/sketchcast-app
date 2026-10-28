/* Spike M1 — derive a Kit Manifest from a LOCAL kit directory.
 *
 *   npx -y tsx tools/sk/manifest/derive.ts <kitDir> --out <outDir> [--no-model] [--cache <dir>] [--cost-log <file>]
 *
 * <kitDir> holds what a read-only fetch saved for ONE presentation generation:
 *   rows.json                    generation / worksheet / artifacts rows, chapter_grounding or article (+ quiz bank)
 *   script.json, script_partN.json
 *   ws_worksheet_questions.json  the kit's worksheet questions (optional)
 *   quiz_questions.json          a catalogue bank-drawn quiz on the same article (optional)
 * Nothing here talks to Supabase. The only network call is Haiku 5.5 on Bedrock
 * (AWS default credential chain), at most TWO calls per kit, cached by input hash.
 * Kit files are untrusted data; they are passed to the model inside tagged blocks.
 */
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import {
  assemble,
  buildSegments,
  segmentsNeedingModel,
  parseModelJson,
  type ArtifactRow,
  type ConceptSrc,
  type ItemSrc,
  type KitInput,
  type ModelAssignment,
  type ModelItem,
  type ScriptFile,
} from "../../../src/sk/manifest/derive";
import { conceptPrompt, itemPrompt, CONCEPT_PROMPT_VERSION, ITEM_PROMPT_VERSION } from "../../../src/sk/manifest/prompts";

const MODEL_ID = "global.anthropic.claude-haiku-5-5"; // = claudeModel("claude-haiku-5-5") in src/utils/claude-backend.ts
const PRICE_IN = 0.1 / 1e6; // worker shared/claude_client.py MODEL_PRICING["claude-haiku-5-5"]
const PRICE_OUT = 0.5 / 1e6;

type Json = Record<string, unknown>;
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function answerText(q: Json): string {
  if (Array.isArray(q.pairs)) return (q.pairs as Json[]).map((p) => `${String(p.left ?? p.a ?? "")} → ${String(p.right ?? p.b ?? "")}`).join("; ");
  const a = q.answer;
  return typeof a === "string" ? a : JSON.stringify(a ?? "");
}

function loadKit(dir: string): KitInput {
  const rows = readJson<Json>(join(dir, "rows.json"));
  const gen = rows.generation as Json;
  const params = (gen.params || {}) as Json;
  const scripts = readdirSync(dir)
    .filter((f) => /^script(_part\d+)?\.json$/.test(f))
    .map((f) => readJson<ScriptFile>(join(dir, f)));
  const artifacts: ArtifactRow[] = [...((rows.artifacts as ArtifactRow[]) || []), ...((rows.quiz_artifacts as ArtifactRow[]) || [])];
  const gid = String(gen.id);
  const hasVideo: Record<number, boolean> = {};
  for (const s of scripts) {
    const p = typeof s.part === "number" && s.part > 0 ? s.part : 1;
    const name = p === 1 ? "lesson.mp4" : `lesson_part${p}.mp4`;
    hasVideo[p] = artifacts.some((a) => a.generation_id === gid && a.kind === "video_mp4" && a.storage_path.endsWith("/" + name));
  }

  let concepts: ConceptSrc[] | null = null;
  let source: KitInput["concept_source"] = "none";
  const cg = (rows.chapter_grounding as Json[] | undefined)?.[0];
  const cgList = ((((cg?.concepts as Json | null)?.concepts as Json | undefined)?.concepts as Json[] | undefined) || null);
  const article = (rows.article as Json[] | undefined)?.[0];
  if (cgList && cgList.length) {
    concepts = cgList.map((c) => ({ concept_id: String(c.concept_id), name: String(c.name), definition: String(c.definition || "") }));
    source = "chapter_grounding";
  } else if (article && Array.isArray(article.objectives) && article.objectives.length) {
    concepts = (article.objectives as Json[]).map((o) => ({ concept_id: String(o.id), name: String(o.text), definition: String(o.text) }));
    source = "article_objectives";
  }

  const items: ItemSrc[] = [];
  const ws = rows.worksheet as Json | undefined;
  const wsPath = join(dir, "ws_worksheet_questions.json");
  if (ws && existsSync(wsPath)) {
    for (const q of (readJson<Json>(wsPath).questions as Json[]) || [])
      items.push({ q_id: `ws:${q.id}`, source: "worksheet", generation_id: String(ws.id), type: String(q.type), prompt: String(q.prompt), answer: answerText(q), bank_item_id: q.bank_item_id as string | undefined, objective_ref: q.objective_ref as string | undefined });
  }
  const quiz = rows.quiz as Json | undefined;
  const quizPath = join(dir, "quiz_questions.json");
  if (quiz && existsSync(quizPath)) {
    const qids = (((rows.question_set as Json[] | undefined)?.[0]?.question_ids as string[]) || []);
    const bank = new Map(((rows.quiz_bank as Json[]) || []).map((b) => [String(b.id), b] as const));
    const oldObj = new Map<string, string>();
    for (const a of (rows.bank_articles as Json[]) || []) for (const o of (a.objectives as Json[]) || []) oldObj.set(`${a.id}:${o.id}`, String(o.text));
    ((readJson<Json>(quizPath).questions as Json[]) || []).forEach((q, i) => {
      const b = bank.get(qids[i]);
      // positional join question_sets.question_ids[i] ↔ q(i+1), confirmed by stem equality
      const linked = b && norm(String(b.stem)) === norm(String(q.prompt)) ? b : undefined;
      const bankArticle = linked ? String(linked.article_id) : undefined;
      const hint = linked && bankArticle !== String(article?.id) ? oldObj.get(`${bankArticle}:${linked.objective_ref}`) : undefined;
      items.push({
        q_id: `quiz:${q.id}`, source: "quiz", generation_id: String(quiz.id), type: String(q.type), prompt: String(q.prompt), answer: answerText(q),
        bank_item_id: linked ? String(linked.id) : undefined, bank_article_id: bankArticle,
        objective_ref: linked ? String(linked.objective_ref) : undefined,
        difficulty: linked && typeof linked.difficulty === "number" ? (linked.difficulty as number) : undefined, hint,
      });
    });
  }
  const fv = params.format_version;
  return {
    generation_id: gid,
    book_id: (gen.book_id as string) || null,
    chapter_ref: (gen.chapter_ref as string) ?? null,
    article_id: (params.article_id as string) || null,
    format_version: fv === undefined || fv === null ? null : Number(fv),
    language: (params.language as string) || scripts[0]?.language || null,
    scripts,
    artifacts,
    concepts,
    concept_source: source,
    items,
    has_video: hasVideo,
  };
}

type Usage = { input_tokens: number; output_tokens: number };

async function haiku(system: string, user: string, cacheDir: string, tag: string, costLog: string): Promise<{ text: string; usage: Usage; cached: boolean }> {
  const key = createHash("sha256").update(MODEL_ID + "\n" + system + "\n" + user).digest("hex").slice(0, 20);
  const cp = join(cacheDir, `${tag}-${key}.json`);
  if (existsSync(cp)) {
    const c = readJson<{ text: string; usage: Usage }>(cp);
    return { ...c, cached: true };
  }
  const client = new AnthropicBedrock({ awsRegion: process.env.BEDROCK_REGION || "us-east-1" });
  const req = {
    model: MODEL_ID,
    max_tokens: 6000, // Haiku 5.5 refuses `temperature` (400 "deprecated for this model")
    system,
    messages: [{ role: "user" as const, content: user }],
    thinking: { type: "disabled" },
  };
  const res = await client.messages.create(req as unknown as Parameters<typeof client.messages.create>[0]) as unknown as {
    content: { type: string; text?: string }[];
    usage: Usage;
    stop_reason: string;
  };
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
  if (res.stop_reason === "max_tokens") throw new Error(`${tag}: reply hit max_tokens (${res.usage.output_tokens} out)`);
  const usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
  writeFileSync(cp, JSON.stringify({ text, usage }, null, 1));
  const usd = usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT;
  appendFileSync(costLog, JSON.stringify({ at: new Date().toISOString(), tag, model: MODEL_ID, ...usage, usd }) + "\n");
  return { text, usage, cached: false };
}

async function main() {
  const dir = process.argv[2];
  const out = arg("--out") || ".";
  const noModel = process.argv.includes("--no-model");
  const cacheDir = arg("--cache") || join(out, "model-cache");
  const costLog = arg("--cost-log") || join(out, "haiku-cost.jsonl");
  mkdirSync(out, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const kit = loadKit(dir);
  const gid8 = kit.generation_id.slice(0, 8);
  let conceptsPass: ModelAssignment[] | undefined;
  let itemsPass: ModelItem[] | undefined;
  const usage = { input_tokens: 0, output_tokens: 0, usd: 0 };
  const add = (u: Usage, cached: boolean) => {
    if (cached) return;
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.usd += u.input_tokens * PRICE_IN + u.output_tokens * PRICE_OUT;
  };
  if (!noModel && kit.concepts && kit.concepts.length) {
    const segs = buildSegments(kit.scripts, kit.artifacts, kit.generation_id);
    const todo = segmentsNeedingModel(segs, kit.concepts);
    if (todo.length) {
      const p = conceptPrompt(kit.concepts, todo.map((s) => ({ key: s.key, type: s.type, heading: s.heading, narration: s.narration })));
      const r = await haiku(p.system, p.user, cacheDir, `${gid8}-${CONCEPT_PROMPT_VERSION}`, costLog);
      add(r.usage, r.cached);
      conceptsPass = parseModelJson<{ assignments: ModelAssignment[] }>(r.text)?.assignments || [];
      console.log(`${gid8} concepts: ${todo.length} segments to model, ${conceptsPass.length} replies, ${r.cached ? "cached" : `${r.usage.input_tokens} in / ${r.usage.output_tokens} out`}`);
    } else conceptsPass = [];
    const pendingItems = kit.items.filter((i) => !(i.bank_item_id && i.objective_ref && i.bank_article_id === kit.article_id));
    if (pendingItems.length) {
      const p = itemPrompt(
        kit.concepts,
        segs.filter((s) => s.slide_k !== null).map((s) => ({ key: s.key, type: s.type, heading: s.heading, narration: s.narration })),
        pendingItems.map((i) => ({ q: i.q_id, type: i.type, prompt: i.prompt, answer: i.answer, hint: i.hint })),
      );
      const r = await haiku(p.system, p.user, cacheDir, `${gid8}-${ITEM_PROMPT_VERSION}`, costLog);
      add(r.usage, r.cached);
      itemsPass = parseModelJson<{ items: ModelItem[] }>(r.text)?.items || [];
      console.log(`${gid8} items: ${pendingItems.length} to model, ${itemsPass.length} replies, ${r.cached ? "cached" : `${r.usage.input_tokens} in / ${r.usage.output_tokens} out`}`);
    } else itemsPass = [];
  }
  const m = assemble(kit, { concepts: conceptsPass, items: itemsPass, model: noModel ? null : MODEL_ID, usage }, new Date().toISOString());
  const target = join(out, `${kit.generation_id}.json`);
  writeFileSync(target, JSON.stringify(m, null, 1));
  console.log(`${gid8} → ${target}  segments=${m.segments.length} concepts=${m.concepts.length} items=${m.items.length} usd=${usage.usd.toFixed(5)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
