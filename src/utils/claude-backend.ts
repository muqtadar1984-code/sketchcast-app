// Which door every Claude call goes through. Server-only.
//
// CLAUDE_BACKEND=anthropic (the default) → the first-party API on ANTHROPIC_API_KEY.
// CLAUDE_BACKEND=bedrock → Amazon Bedrock (AWS Activate credits pay), region
// BEDROCK_REGION (default us-east-1). Credentials: with AWS_ROLE_ARN set, the
// deployment's Vercel OIDC token is exchanged for short-lived role credentials
// (no long-lived keys); without it, the AWS SDK's default chain reads
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Static keys left in place also
// catch a failed role exchange, so the cut-over can't take Claude down.
//
// Both clients expose the same .messages.create / .messages.stream surface, so
// callers never branch: they take a client from claudeClient() and route every
// `model:` through claudeModel(). Kept free of Supabase/Stripe imports so it is
// cheap to unit-test; utils/tutor/service.ts re-exports it as `anthropic()`.

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

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

type AwsCredentialProvider = ReturnType<typeof awsCredentialsProvider>;
type AwsCredentials = Awaited<ReturnType<AwsCredentialProvider>>;

/** Refresh role credentials this long before STS says they expire. */
const CREDENTIAL_REFRESH_MS = 5 * 60_000;

// One set of role credentials per warm function instance. The Bedrock SDK asks
// for credentials on EVERY request; without this each Claude call would pay an
// STS AssumeRoleWithWebIdentity round trip first.
let roleCache: { roleArn: string; creds: AwsCredentials } | null = null;
let roleInflight: { roleArn: string; promise: Promise<AwsCredentials> } | null = null;

/** Test hook: forget cached role credentials. */
export function resetBedrockCredentialCache(): void {
  roleCache = null;
  roleInflight = null;
}

function stillFresh(creds: AwsCredentials): boolean {
  if (!creds.expiration) return true;
  return creds.expiration.getTime() - Date.now() > CREDENTIAL_REFRESH_MS;
}

/** AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN), if both set. */
function staticEnvCredentials(): AwsCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** Credentials for AWS_ROLE_ARN via the Vercel OIDC token, cached until near
 * expiry and shared by concurrent requests. If the exchange fails (no OIDC token
 * — e.g. local dev — or a trust-policy mistake) and static keys are present,
 * those answer instead, logged; with no static keys the failure stands. */
export function bedrockRoleCredentials(roleArn: string, region: string): AwsCredentialProvider {
  const assume = awsCredentialsProvider({
    roleArn,
    roleSessionName: "sketchcast-app",
    clientConfig: { region },
  });
  return async () => {
    if (roleCache?.roleArn === roleArn && stillFresh(roleCache.creds)) return roleCache.creds;
    if (roleInflight?.roleArn !== roleArn) {
      const promise = assume().finally(() => {
        if (roleInflight?.promise === promise) roleInflight = null;
      });
      roleInflight = { roleArn, promise };
    }
    try {
      const creds = await roleInflight.promise;
      roleCache = { roleArn, creds };
      return creds;
    } catch (e) {
      const fallback = staticEnvCredentials();
      if (!fallback) throw e;
      console.error("[claude] Vercel OIDC role exchange failed — using static AWS keys:", e);
      return fallback;
    }
  };
}

/** A client for the selected backend. Throws when the first-party key is
 * missing; on Bedrock, credentials resolve (and, if absent, reject) at request
 * time — from AWS_ROLE_ARN via Vercel OIDC when set, else the default chain. */
export function claudeClient(): ClaudeClient {
  if (claudeBackend() === "bedrock") {
    const awsRegion = process.env.BEDROCK_REGION || "us-east-1";
    const roleArn = (process.env.AWS_ROLE_ARN || "").trim();
    if (!roleArn) return new AnthropicBedrock({ awsRegion });
    const provider = bedrockRoleCredentials(roleArn, awsRegion);
    return new AnthropicBedrock({ awsRegion, providerChainResolver: async () => provider });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey: key });
}
