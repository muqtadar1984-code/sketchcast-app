// The knowledge-object library — registry, instantiation, semantic catalog
// (design §4). Tiered growth: Tier 1 curated, Tier 2 composed from primitives,
// Tier 3 generated-and-quarantined (schema slot only in Phase 0 — a generated
// object can be registered with tier 3 but never silently joins the canon).

import type { CatalogEntry, KnowledgeObject, Part } from "./types";
import type { LogicalPos, Provenance, SceneNode } from "../scene/types";
import type { Instantiator } from "../scene/graph";
import type { LibraryReader } from "../tal/validate";
import { PRIMITIVES } from "./primitives";

/** Object-level anchors every instance gets for free (local 0–100 space). */
const DEFAULT_ANCHORS: NonNullable<SceneNode["anchors"]> = [
  { id: "center", at: [50, 50] },
  { id: "top", at: [50, 0] },
  { id: "bottom", at: [50, 100] },
  { id: "left", at: [0, 50] },
  { id: "right", at: [100, 50] },
];

export class Library implements LibraryReader, Instantiator {
  private objects = new Map<string, KnowledgeObject>();

  constructor(objects: KnowledgeObject[] = [], { primitives = true } = {}) {
    if (primitives) for (const p of PRIMITIVES) this.register(p);
    for (const o of objects) this.register(o);
  }

  register(ko: KnowledgeObject): void {
    this.objects.set(ko.id, ko);
  }

  get(ref: string): KnowledgeObject | undefined {
    return this.objects.get(ref);
  }

  // ── LibraryReader (TAL semantic validation) ──
  has(ref: string): boolean {
    return this.objects.has(ref);
  }
  statesOf(ref: string): string[] {
    return (this.objects.get(ref)?.states ?? []).map((s) => s.id);
  }
  stepsOf(ref: string): string[] {
    return (this.objects.get(ref)?.steps ?? []).map((s) => s.op);
  }
  partsOf(ref: string): string[] {
    return (this.objects.get(ref)?.parts ?? []).map((p) => p.id);
  }
  hasDynamicParts(ref: string): boolean {
    return !!this.objects.get(ref)?.dynamicParts;
  }
  anchorsOf(ref: string): string[] {
    const ko = this.objects.get(ref);
    if (!ko) return [];
    return [
      ...new Set([
        "center",
        "top",
        "bottom",
        "left",
        "right",
        ...(ko.anchors ?? []).map((a) => a.id),
        ...ko.parts.map((p) => p.id), // a part id is a valid anchor (its centroid)
      ]),
    ];
  }

  // ── Instantiator (scene-graph fold) ──
  instantiate(
    ref: string,
    as: string,
    at: LogicalPos,
    props: Record<string, unknown> | undefined,
    provenance: Provenance,
  ): SceneNode | null {
    const ko = this.objects.get(ref);
    if (!ko) return null;
    const node: SceneNode = {
      id: as,
      kind: ref.startsWith("prim.") ? "primitive" : "object",
      ref,
      transform: { at },
      props: props ? { ...props } : undefined,
      visible: false, // placed, not yet drawn
      anchors: [...DEFAULT_ANCHORS, ...(ko.anchors ?? [])],
      meta: { subject: ko.subjects[0], tags: ko.tags },
      provenance,
      parts: [],
    };
    node.parts = this.buildParts(ko, node);
    return node;
  }

  refreshParts(node: SceneNode): void {
    const ko = node.ref ? this.objects.get(node.ref) : undefined;
    if (!ko) return;
    const wasVisible = node.visible;
    node.parts = this.buildParts(ko, node);
    if (wasVisible) node.parts.forEach((p) => setVisibleDeep(p, true));
  }

  private buildParts(ko: KnowledgeObject, node: SceneNode): SceneNode[] {
    const defs: Part[] = [...ko.parts, ...(ko.dynamicParts ? ko.dynamicParts(node.props ?? {}) : [])];
    return defs.map((d) => ({
      id: d.id,
      kind: "primitive" as const,
      geometry: d.geometry,
      style: d.style,
      transform: { at: { coord: [50, 50] as [number, number] } }, // parts live in parent-local space
      visible: node.visible && !d.hiddenByDefault,
      anchors: d.anchors,
      meta: { label: d.name },
      provenance: node.provenance,
      props: d.hiddenByDefault ? { hiddenByDefault: true } : undefined,
    }));
  }

  /** Pure step computation (design `step` op). The interpreter emits the patch
   * as an event; the graph fold applies it — so replay reproduces steps exactly. */
  computeStep(
    ref: string,
    props: Record<string, unknown>,
    step: string,
    args: Record<string, unknown> | undefined,
    state: string | undefined,
  ): { props?: Record<string, unknown>; state?: string; emphasize?: string[] } | null {
    const def = this.objects.get(ref)?.steps?.find((s) => s.op === step);
    if (!def) return null;
    return def.apply({ ...props }, args, state);
  }

  /** The semantic index fed to the tutor prompt (design §4.3) — the tutor may
   * only emit refs that exist here or compose from primitives. */
  catalog(opts: { subjects?: string[]; includePrimitives?: boolean } = {}): CatalogEntry[] {
    const { subjects, includePrimitives = true } = opts;
    return [...this.objects.values()]
      .filter((o) => includePrimitives || !o.id.startsWith("prim."))
      .filter((o) => o.tier !== 3) // quarantined objects never reach the prompt
      .filter((o) => !subjects || o.subjects.includes("*") || o.subjects.some((s) => subjects.includes(s)))
      .map((o) => ({
        id: o.id,
        name: o.name,
        subjects: o.subjects,
        tags: o.tags,
        difficulty: o.difficulty,
        parts: o.parts.map((p) => p.id),
        states: o.states.map((s) => s.id),
        steps: (o.steps ?? []).map((s) => s.op),
        props: o.renderHints?.props as string[] | undefined,
      }));
  }
}

function setVisibleDeep(n: SceneNode, v: boolean): void {
  if (n.props?.hiddenByDefault && v) return; // state-gated parts stay hidden until a state shows them
  n.visible = v;
  n.parts?.forEach((c) => setVisibleDeep(c, v));
}
