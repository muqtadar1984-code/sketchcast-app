// SK B9 — the Amazon Polly adapter (server only): SK's own lines as neural
// mp3 with word + viseme marks, through the SpeechProvider seam. Credentials
// take the Bedrock client's path — AWS_ROLE_ARN assumed through the Vercel
// OIDC token (the shared, cached exchange in utils/claude-backend), static
// keys otherwise — so the only new grant is `polly:SynthesizeSpeech` on the
// role (docs/SK-CONTRACTS.md §1.3.1).
//
// Two Polly calls per line, in parallel: one for the audio, one for the
// marks (Polly returns marks INSTEAD of audio, as JSON lines). Both are
// billed by character, so a line costs twice its length at the neural rate.
// Nothing is cached, on disk or in memory. The AWS SDK is imported lazily so
// the module loads anywhere (tests pass `send`; no live call is ever made
// without SK_TTS=polly).

import { EMPTY_MARKS, type SpeechProvider, type SpeechResult, type SynthesizeOpts, type VoiceId } from "./provider";
import { MAX_SPEAK_CHARS, parseSpeechMarks, pollyVoiceName, ssmlFor } from "./polly-marks";

export { MAX_SPEAK_CHARS, POLLY_VOICES, pollyVoiceFor, pollyVoiceName, voiceForLook } from "./polly-marks";

export type PollyRequest = {
  Engine: "neural";
  OutputFormat: "mp3" | "json";
  SpeechMarkTypes?: ("word" | "viseme")[];
  Text: string;
  TextType: "ssml";
  VoiceId: string;
};

/** The one call the adapter makes; tests replace it. Returns the response body bytes. */
export type PollySend = (req: PollyRequest, signal?: AbortSignal) => Promise<Uint8Array>;

export type PollySpeechOptions = { region?: string; send?: PollySend };

type PollyClientLike = { send: (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<{ AudioStream?: { transformToByteArray(): Promise<Uint8Array> } }> };

export class PollySpeechProvider implements SpeechProvider {
  readonly id = "polly";
  /** Characters billed so far by this instance (audio + marks). */
  chars = 0;
  private readonly region: string;
  private readonly sendOverride?: PollySend;
  private client: Promise<{ client: PollyClientLike; Command: new (input: PollyRequest) => unknown }> | null = null;

  constructor(opts: PollySpeechOptions = {}) {
    this.region = opts.region || process.env.POLLY_REGION || process.env.BEDROCK_REGION || "us-east-1";
    this.sendOverride = opts.send;
  }

  private async send(req: PollyRequest, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.sendOverride) return this.sendOverride(req, signal);
    if (!this.client) {
      this.client = (async () => {
        const { PollyClient, SynthesizeSpeechCommand } = await import("@aws-sdk/client-polly");
        const roleArn = (process.env.AWS_ROLE_ARN || "").trim();
        const credentials = roleArn ? (await import("@/utils/claude-backend")).bedrockRoleCredentials(roleArn, this.region) : undefined;
        const client = new PollyClient({ region: this.region, ...(credentials ? { credentials } : {}) }) as unknown as PollyClientLike;
        return { client, Command: SynthesizeSpeechCommand as unknown as new (input: PollyRequest) => unknown };
      })();
      this.client.catch(() => {
        this.client = null;
      });
    }
    const { client, Command } = await this.client;
    const res = await client.send(new Command(req), signal ? { abortSignal: signal } : undefined);
    if (!res.AudioStream) throw new Error("polly: empty response");
    return res.AudioStream.transformToByteArray();
  }

  async synthesize(text: string, voice: VoiceId, opts: SynthesizeOpts): Promise<SpeechResult> {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return { audio: new Uint8Array(0), format: "mp3", marks: EMPTY_MARKS };
    if (line.length > MAX_SPEAK_CHARS) throw new Error(`polly: line of ${line.length} chars exceeds ${MAX_SPEAK_CHARS}`);
    const doc = ssmlFor(line);
    const VoiceId = pollyVoiceName(voice);
    const base = { Engine: "neural" as const, Text: doc.ssml, TextType: "ssml" as const, VoiceId };
    const kinds = opts.marks.filter((k): k is "word" | "viseme" => k === "word" || k === "viseme");
    const audioP = this.send({ ...base, OutputFormat: "mp3" }, opts.signal);
    const marksP = kinds.length ? this.send({ ...base, OutputFormat: "json", SpeechMarkTypes: kinds }, opts.signal) : null;
    const [audio, raw] = await Promise.all([audioP, marksP]);
    this.chars += line.length * (marksP ? 2 : 1);
    const marks = raw ? parseSpeechMarks(new TextDecoder().decode(raw), doc) : EMPTY_MARKS;
    return { audio, format: "mp3", marks };
  }
}

/** True when a Polly call can be attempted: the same credential rule as the
 * Bedrock clients (static keys, or a role to assume via Vercel OIDC). */
export function pollyConfigured(): boolean {
  return Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ROLE_ARN || process.env.AWS_PROFILE || process.env.AWS_SDK_LOAD_CONFIG);
}
