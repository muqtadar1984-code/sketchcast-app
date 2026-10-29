// SK S6 slice B — the server half of Amazon Transcribe streaming (SERVER ONLY):
// region, credentials, the per-user URL budget, and the voice-consent check
// that POST /api/sk/stt/url runs before it signs anything.
//
// Credentials take the Polly/Bedrock path unchanged: with AWS_ROLE_ARN the
// Vercel OIDC token is exchanged for short-lived role credentials through the
// shared, cached bedrockRoleCredentials() (utils/claude-backend), so the URL
// carries an X-Amz-Security-Token; without it, AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN). The only new grant on the role
// is transcribe:StartStreamTranscriptionWebSocket (docs/sk-transcribe.md).
//
// Nothing here calls AWS except the STS exchange that already serves Bedrock
// and Polly; minutes are only spent when a BROWSER opens the signed socket.

import { STT_URLS_PER_HOUR } from "./stt";
import type { AwsCreds } from "./transcribe-presign";

export function sttRegion(): string {
  return (process.env.STT_REGION || "").trim() || "us-east-1";
}

type CredSource = () => Promise<AwsCreds>;

function staticEnv(): AwsCreds | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

let credsOverride: CredSource | null = null;
let roleSource: { roleArn: string; region: string; get: CredSource } | null = null;

/** Credentials to sign with. Throws when none are configured. */
export async function sttCredentials(): Promise<AwsCreds> {
  if (credsOverride) return credsOverride();
  const roleArn = (process.env.AWS_ROLE_ARN || "").trim();
  if (roleArn) {
    const region = sttRegion();
    if (roleSource?.roleArn !== roleArn || roleSource.region !== region) {
      const { bedrockRoleCredentials } = await import("@/utils/claude-backend");
      const provider = bedrockRoleCredentials(roleArn, region);
      roleSource = { roleArn, region, get: async () => provider() };
    }
    const c = await roleSource.get();
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) };
  }
  const s = staticEnv();
  if (!s) throw new Error("transcribe: no AWS credentials configured");
  return s;
}

// ── the URL budget: STT_URLS_PER_HOUR per user, rolling hour, per instance ──
// In memory on purpose: it is a brake on a runaway client loop, not billing.
// Each warm serverless instance keeps its own count, so the true ceiling is
// STT_URLS_PER_HOUR × instances; the founder's AWS budget alarm is the hard cap.
const HOUR_MS = 60 * 60_000;
const issued = new Map<string, number[]>();

/** Take one URL from the user's budget; false when the hour's budget is spent. */
export function takeSttUrl(userId: string, now: number = Date.now()): boolean {
  const recent = (issued.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= STT_URLS_PER_HOUR) {
    issued.set(userId, recent);
    return false;
  }
  recent.push(now);
  issued.set(userId, recent);
  // Keep the map from growing without bound on a long-lived instance.
  if (issued.size > 5000) {
    for (const [k, v] of issued) if (!v.some((t) => now - t < HOUR_MS)) issued.delete(k);
  }
  return true;
}

/** Tests: replace the credential source (null = the real one) and clear the budget. */
export function __setSttForTests(o: { credentials?: CredSource | null } = {}): void {
  credsOverride = o.credentials ?? null;
  roleSource = null;
  issued.clear();
}
