// AI Tutor Phase 2 — "sketch" spec authoring + validation + cache key. The Coach
// designs ONE whiteboard slide (heading / bullets / optional diagram) + a short
// narration; the worker renders it to a $0 animated clip. Server-only (uses
// node:crypto); never imported by client components.

import { createHash } from "crypto";
import { buildSystemPrompt, type Grounding } from "./models";

// Bump when the renderer's slide contract changes so every cached clip invalidates.
export const SKETCH_CONTRACT_VERSION = "v1";
// Per-account monthly cap on NEW sketch renders (cache replays don't count).
export const SKETCH_MONTHLY_CAP = 30;

// Mirrors the worker's SlideVisual (agent3_scripts/models.py) that the native
// renderer consumes — so whatever the Coach returns renders with zero glue.
export type SketchVisualKind = "flow" | "cycle" | "hierarchy" | "compare" | "icons";
export type SketchVisual = {
  kind: SketchVisualKind;
  nodes?: string[];
  groups?: { heading: string; items: string[] }[];
  items?: { icon: string; label: string }[];
  caption?: string;
};
export type SketchSpec = { heading: string; points: string[]; visual: SketchVisual | null };
export type ParsedSketch = { spec: SketchSpec; narration: string };

const VISUAL_KINDS: SketchVisualKind[] = ["flow", "cycle", "hierarchy", "compare", "icons"];
const s = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The spec-authoring prompt. Reuses the chat tutor's closed-book fence and asks
 * for STRICT JSON shaped exactly like the renderer's slide contract. */
export function buildSketchPrompt(grounding: Grounding, concept: string): { instructions: string; context: string } {
  const { context } = buildSystemPrompt(grounding);
  const topic = concept ? `"${concept}"` : "the key idea the student is asking about";
  const instructions =
    `You are "Coach". Design ONE whiteboard slide that explains ${topic} for the chapter ` +
    `"${grounding.chapterTitle}", using ONLY the CHAPTER CONTEXT provided. Reply with STRICT JSON ONLY ` +
    `(no prose, no markdown) in exactly this shape:\n` +
    `{"heading":"3-7 word title","points":["short factual bullet under 12 words","2 to 4 bullets from the chapter"],` +
    `"visual":null,"narration":"2-4 warm sentences Coach says while drawing"}\n` +
    `Use "visual" ONLY when the idea is naturally a process/cycle/hierarchy/comparison/set of items — then set it to ` +
    `{"kind":"flow|cycle|hierarchy|compare|icons","nodes":["step","step",...],"caption":"optional"} and you may drop ` +
    `points. Otherwise keep "visual": null and use 2-4 bullets. Never invent facts beyond the chapter; keep it ` +
    `child-friendly and safe. If the question can't be drawn from this chapter, still return the JSON with an empty ` +
    `points array and a narration that gently redirects to the chapter.`;
  return { instructions, context };
}

function parseVisual(v: unknown): SketchVisual | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  let kind = String(o.kind ?? "").toLowerCase() as SketchVisualKind;
  if (!VISUAL_KINDS.includes(kind)) return null;

  const nodes = Array.isArray(o.nodes) ? o.nodes.map((n) => s(n, 40)).filter(Boolean).slice(0, 5) : [];
  const groups = Array.isArray(o.groups)
    ? o.groups
        .map((g) => {
          const go = (g ?? {}) as Record<string, unknown>;
          return { heading: s(go.heading, 40), items: (Array.isArray(go.items) ? go.items : []).map((i) => s(i, 40)).filter(Boolean).slice(0, 4) };
        })
        .filter((g) => g.heading || g.items.length)
        .slice(0, 2)
    : [];
  const items = Array.isArray(o.items)
    ? o.items
        .map((i) => {
          const io = (i ?? {}) as Record<string, unknown>;
          return { icon: s(io.icon, 24) || "spark", label: s(io.label, 40) };
        })
        .filter((i) => i.label)
        .slice(0, 6)
    : [];
  const caption = s(o.caption, 80);

  // Downgrade a too-short cycle to a flow (matches the worker's _parse_slide_visual).
  if (kind === "cycle" && nodes.length < 3) kind = "flow";

  // Drop a visual that carries nothing renderable → caller falls back to bullets.
  // Thresholds mirror the worker's diagram_builder.render_diagram so we never
  // cache a visual the renderer would silently drop (icons needs ≥2).
  const hasContent =
    ((kind === "flow" || kind === "cycle" || kind === "hierarchy") && nodes.length >= 2) ||
    (kind === "compare" && groups.length >= 1) ||
    (kind === "icons" && items.length >= 2);
  if (!hasContent) return null;

  const out: SketchVisual = { kind, caption: caption || undefined };
  if (nodes.length) out.nodes = nodes;
  if (groups.length) out.groups = groups;
  if (items.length) out.items = items;
  return out;
}

/** Validate + clamp the model's JSON into a renderable sketch. Returns null when
 * there's nothing to draw (empty heading, or no bullets/visual/narration). */
export function parseSketchSpec(raw: string): ParsedSketch | null {
  let data: Record<string, unknown>;
  try {
    const text = (raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const heading = s(data.heading, 80);
  const points = (Array.isArray(data.points) ? data.points : []).map((p) => s(p, 120)).filter(Boolean).slice(0, 4);
  const visual = parseVisual(data.visual);
  const narration = s(data.narration, 600);

  if (!heading) return null;
  if (points.length === 0 && !visual && !narration) return null;
  return { spec: { heading, points, visual }, narration };
}

// Stable stringify (sorted keys) so semantically-identical specs hash equal — that
// equality IS the cross-student $0 replay. Only key order is normalised; strings
// are NOT lowercased/stripped, so genuinely different content never collides.
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** The cache key: a hash over (contract version, spec, narration, voice). Changing
 * the narration or voice correctly busts the cache; bumping the contract version
 * invalidates every clip after a renderer change. */
export function canonicalSpecHash(spec: SketchSpec, narration: string, voiceId: string): string {
  const payload = `${SKETCH_CONTRACT_VERSION}\n${stable(spec)}\n${narration}\n${voiceId}`;
  return createHash("sha256").update(payload).digest("hex");
}
