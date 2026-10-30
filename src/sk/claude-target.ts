// SK — where SK's own Claude calls go (2026-10-30). Server-only.
//
// SK may run in another Bedrock region than the rest of the app (Sydney for
// SK while every other Claude call stays where BEDROCK_REGION puts it):
//   SK_BEDROCK_REGION      the region for SK's calls; unset = today's behaviour
//                          (BEDROCK_REGION, default us-east-1);
//   SK_BEDROCK_MODEL_MAP   a JSON object overlaying model ids for SK only
//                          (e.g. {"claude-sonnet-5-5":"au.anthropic.claude-sonnet-5-5"});
//                          malformed = ignored + logged, like BEDROCK_MODEL_MAP.
// Read only by SK's server calls: the Shell turn route (fast and full models,
// the teaching / selection / board-knowledge calls, the translation), and
// src/sk/server.ts (router, teacher, translate providers). On the first-party
// API both are ignored: ids pass through and there is no region.

import { bedrockRegion, claudeBackend, parseModelMap } from "@/utils/claude-backend";
import type { ProviderTarget } from "@/utils/assistant/providers/anthropic";

/** SK_BEDROCK_REGION, or undefined when unset (the app-wide region applies). */
export function skBedrockRegion(): string | undefined {
  const r = (process.env.SK_BEDROCK_REGION ?? "").trim();
  return r || undefined;
}

/** SK_BEDROCK_MODEL_MAP, parsed ({} when unset or malformed). */
export function skModelMap(): Record<string, string> {
  return parseModelMap(process.env.SK_BEDROCK_MODEL_MAP, "SK_BEDROCK_MODEL_MAP");
}

/** The target every SK provider is built with. Empty = the app-wide defaults. */
export function skProviderTarget(): ProviderTarget {
  const region = skBedrockRegion();
  const map = skModelMap();
  return { ...(region ? { region } : {}), ...(Object.keys(map).length ? { modelMap: map } : {}) };
}

/** For the per-turn timing log: the region SK's calls went to, or "anthropic"
 *  on the first-party API. Never an env secret. */
export function skRegionLabel(): string {
  return claudeBackend() === "bedrock" ? (skBedrockRegion() ?? bedrockRegion()) : "anthropic";
}
