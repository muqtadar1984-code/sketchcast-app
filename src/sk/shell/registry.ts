// SK Shell — the capability registry filter (Final Plan §9.7). The router and
// the model see ONLY the entries the Context allows: roles ∩ hat ∩ flags ∩
// plans. The same predicate runs again at execution time (runner.ts, §2.5).

import type { ToolDef } from "@/utils/assistant/provider";
import type { SkCapability, SkCapabilityMeta, SkContext } from "./types";
import { effectiveRoles } from "./context";
import { REGISTRY } from "@/sk/capabilities";

export function metaAllows(meta: SkCapabilityMeta, ctx: SkContext): boolean {
  const roles = effectiveRoles(ctx);
  if (!meta.roles.some((r) => roles.includes(r))) return false;
  // A hat narrows: with hats on, the active hat must be listed; with hats off
  // (hat null) the union view applies and the role decides alone.
  if (meta.hats?.length && ctx.user.hat && !meta.hats.includes(ctx.user.hat)) return false;
  if (meta.flags?.some((f) => ctx.flags[f] !== true)) return false;
  if (meta.plans?.length && !meta.plans.includes(ctx.user.plan) && !ctx.user.staff) return false;
  return true;
}

export function allowedFor(ctx: SkContext, entries: SkCapability[] = REGISTRY): SkCapability[] {
  return entries.filter((e) => metaAllows(e.meta, ctx));
}

export function toToolDefs(entries: SkCapability[]): ToolDef[] {
  return entries.map((e) => ({ name: e.meta.name, description: e.meta.description, parameters: e.meta.parameters }));
}

export function findCapability(name: string, entries: SkCapability[] = REGISTRY): SkCapability | null {
  return entries.find((e) => e.meta.name === name) ?? null;
}
