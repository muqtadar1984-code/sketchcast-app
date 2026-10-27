// SK retrieval — the query/block embedder: Amazon Titan Text Embeddings v2
// through Bedrock (InvokeModel), 1024 dims, normalised, so cosine = dot
// product and the 0.32 gate from the R1 Titan re-run applies.
//
// Credentials follow the Claude backend's rule (utils/claude-backend.ts): with
// AWS_ROLE_ARN set, the Vercel OIDC token is exchanged for role credentials
// (cached there); otherwise the SDK's default chain (static keys on Vercel,
// ~/.aws locally). Region = BEDROCK_REGION (default us-east-1).
//
// IAM: the identity needs bedrock:InvokeModel on the model id below. On
// 2026-10-27 the sketchcast-ops USER has it (local runs); the Vercel ROLE
// (AWS_ROLE_ARN) does NOT yet — grant it before SK_RETRIEVAL=hybrid is set in
// production, or every grounded question falls back to unit-only grounding.
//
// Server-only (reads env, loads the AWS SDK lazily).

export const DEFAULT_EMBED_MODEL = "amazon.titan-embed-text-v2:0";
export const EMBED_DIMS = 1024;
/** Titan v2 accepts up to 8,192 tokens; blocks are far shorter. A hard cap on
 * characters keeps a runaway table from being rejected. */
const MAX_INPUT_CHARS = 20_000;

export interface Embedder {
  /** The model id, stored beside each block vector (re-embed when it changes). */
  readonly model: string;
  readonly dims: number;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

export type TitanEmbedderOptions = {
  model?: string;
  region?: string;
  /** Test hook: the InvokeModel call. Default builds a BedrockRuntimeClient. */
  invoke?: (body: string, signal?: AbortSignal) => Promise<string>;
};

/** What the Titan v2 response body carries. */
type TitanResponse = { embedding?: unknown; inputTextTokenCount?: number };

export class TitanEmbedder implements Embedder {
  readonly model: string;
  readonly dims = EMBED_DIMS;
  private readonly region: string;
  private readonly invokeOverride?: TitanEmbedderOptions["invoke"];
  private client: Promise<{ send: (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<{ body: Uint8Array }> }> | null = null;
  private Invoke: (new (input: unknown) => unknown) | null = null;
  /** Input tokens counted by Titan across this instance (cost tracking). */
  tokens = 0;
  calls = 0;

  constructor(opts: TitanEmbedderOptions = {}) {
    this.model = opts.model || process.env.SK_EMBED_MODEL || DEFAULT_EMBED_MODEL;
    this.region = opts.region || process.env.BEDROCK_REGION || "us-east-1";
    this.invokeOverride = opts.invoke;
  }

  private async invoke(body: string, signal?: AbortSignal): Promise<string> {
    if (this.invokeOverride) return this.invokeOverride(body, signal);
    if (!this.client) {
      this.client = (async () => {
        const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
        this.Invoke = InvokeModelCommand as unknown as new (input: unknown) => unknown;
        const roleArn = (process.env.AWS_ROLE_ARN || "").trim();
        // The role exchange lives beside the Claude client (shared credential
        // cache); imported only when a role is set so local tools stay light.
        const credentials = roleArn ? (await import("@/utils/claude-backend")).bedrockRoleCredentials(roleArn, this.region) : undefined;
        return new BedrockRuntimeClient({ region: this.region, ...(credentials ? { credentials } : {}) }) as unknown as { send: (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<{ body: Uint8Array }> };
      })();
      this.client.catch(() => {
        this.client = null;
      });
    }
    const client = await this.client;
    const cmd = new this.Invoke!({ modelId: this.model, contentType: "application/json", accept: "application/json", body });
    const res = await client.send(cmd, signal ? { abortSignal: signal } : undefined);
    return new TextDecoder().decode(res.body);
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const inputText = text.replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
    if (!inputText) throw new Error("embed: empty text");
    const raw = await this.invoke(JSON.stringify({ inputText, dimensions: this.dims, normalize: true }), signal);
    const parsed = JSON.parse(raw) as TitanResponse;
    const v = parsed.embedding;
    if (!Array.isArray(v) || v.length !== this.dims || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new Error(`embed: ${this.model} returned ${Array.isArray(v) ? v.length : typeof v} values, expected ${this.dims}`);
    }
    this.calls += 1;
    this.tokens += typeof parsed.inputTextTokenCount === "number" ? parsed.inputTextTokenCount : Math.ceil(inputText.length / 4);
    return v as number[];
  }
}

/** True when an embedding call can be attempted (the same rule as Claude on
 * Bedrock: static keys, or a role to assume). Local runs with ~/.aws profiles
 * set AWS_PROFILE or AWS_SDK_LOAD_CONFIG; the tool checks nothing more. */
export function embedderConfigured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ROLE_ARN || process.env.AWS_PROFILE || process.env.AWS_SDK_LOAD_CONFIG);
}
