// Which door every Claude call goes through. Server-only.
//
// CLAUDE_BACKEND=anthropic (the default) → the first-party API on ANTHROPIC_API_KEY.
// CLAUDE_BACKEND=bedrock → Amazon Bedrock (AWS Activate credits pay), on the AWS
// credentials in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or a
// role), region BEDROCK_REGION (default us-east-1).
//
// Both clients expose the same .messages.create / .messages.stream surface, so
// callers never branch: they take a client from claudeClient() and route every
// `model:` through claudeModel(). Kept free of Supabase/Stripe imports so it is
// cheap to unit-test; utils/tutor/service.ts re-exports it as `anthropic()`.

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

export type ClaudeBackend = "anthropic" | "bedrock";

/** The one surface the app uses — both SDK clients satisfy it. (Bedrock's
 * messages resource has no batches/countTokens, so the type stops at these two.) */
export type ClaudeClient = { messages: Pick<Anthropic["messages"], "create" | "stream"> };

export function claudeBackend(): ClaudeBackend {
  return (process.env.CLAUDE_BACKEND || "").trim().toLowerCase() === "bedrock" ? "bedrock" : "anthropic";
}

/** First-party id → Bedrock GLOBAL cross-region inference profile (the same
 * profiles the worker uses, sketchcast-ai PR #273). Global profiles route to any
 * region with capacity and are priced like the base model. */
export const BEDROCK_MODEL_IDS: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-haiku-4-5-20251001": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-sonnet-4-6": "global.anthropic.claude-sonnet-4-6",
  "claude-sonnet-5": "global.anthropic.claude-sonnet-5",
};

/** BEDROCK_MODEL_MAP — a JSON object overlaid on the table above, so a new model
 * or a regional profile is one env change, not a deploy. A malformed value is
 * ignored (logged), never fatal: the built-in table still answers. */
function envModelMap(): Record<string, string> {
  const raw = process.env.BEDROCK_MODEL_MAP;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && v) out[k] = v;
    return out;
  } catch (e) {
    console.error("[claude] BEDROCK_MODEL_MAP is not a JSON object of strings — ignored:", e);
    return {};
  }
}

/** The model id to send. Unchanged on the first-party API. On Bedrock, a known
 * first-party id becomes its inference profile; anything else (already a Bedrock
 * id, or a model nobody mapped) passes through so Bedrock names the problem. */
export function claudeModel(id: string): string {
  if (claudeBackend() !== "bedrock") return id;
  return envModelMap()[id] ?? BEDROCK_MODEL_IDS[id] ?? id;
}

/** True when a Claude call can be attempted on the selected backend — the check
 * a route makes before choosing between the model and its template fallback. */
export function claudeConfigured(): boolean {
  if (claudeBackend() === "bedrock") {
    // Static keys, or a role to assume (Vercel OIDC / web identity).
    return Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ROLE_ARN);
  }
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** A client for the selected backend. Throws when the first-party key is
 * missing; on Bedrock the AWS SDK's default credential chain resolves (and, if
 * absent, rejects) at request time. */
export function claudeClient(): ClaudeClient {
  if (claudeBackend() === "bedrock") {
    return new AnthropicBedrock({ awsRegion: process.env.BEDROCK_REGION || "us-east-1" });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey: key });
}
