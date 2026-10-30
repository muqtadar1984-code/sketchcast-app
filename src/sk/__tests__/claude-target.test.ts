/**
 * SK's own Bedrock region and model overlay (SK_BEDROCK_REGION,
 * SK_BEDROCK_MODEL_MAP): unset = today's behaviour; set = SK's providers go to
 * that region with those ids; every other Claude caller is unaffected.
 * No network: both SDK clients are fakes that record how they were built and
 * what model each request named.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/__tests__/claude-target.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({ bedrock: [] as Array<{ awsRegion: string }>, anthropic: 0, models: [] as string[], tools: [] as unknown[] }));

async function* oneMessage() {
  yield { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 } } };
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
  yield { type: "message_delta", usage: { output_tokens: 3 } };
}
const create = async (body: { model: string; tools?: unknown[] }) => {
  rec.models.push(body.model);
  rec.tools.push(body.tools);
  return oneMessage();
};
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create, stream: vi.fn() };
    constructor() {
      rec.anthropic++;
    }
  },
}));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  AnthropicBedrock: class {
    messages = { create, stream: vi.fn() };
    constructor(opts: { awsRegion: string }) {
      rec.bedrock.push({ awsRegion: opts.awsRegion });
    }
  },
}));
vi.mock("@vercel/oidc-aws-credentials-provider", () => ({ awsCredentialsProvider: () => async () => ({}) }));

import { claudeClient } from "@/utils/claude-backend";
import { AnthropicProvider, toAnthropicTools } from "@/utils/assistant/providers/anthropic";
import { skModelMap, skProviderTarget, skRegionLabel } from "@/sk/claude-target";

const SK_MAP = JSON.stringify({ "claude-sonnet-5-5": "au.anthropic.claude-sonnet-5-5", "claude-haiku-5-5": "au.anthropic.claude-haiku-5-5" });

async function drain(p: AnthropicProvider, tools = false) {
  const out = [];
  for await (const ev of p.stream({ system: "s", messages: [{ role: "user", text: "q" }], ...(tools ? { tools: [{ name: "a", description: "a", parameters: {} }, { name: "b", description: "b", parameters: {} }] } : {}) })) out.push(ev);
  return out;
}

beforeEach(() => {
  for (const v of ["CLAUDE_BACKEND", "BEDROCK_REGION", "BEDROCK_MODEL_MAP", "SK_BEDROCK_REGION", "SK_BEDROCK_MODEL_MAP", "AWS_ROLE_ARN", "ANTHROPIC_API_KEY"]) vi.stubEnv(v, "");
  rec.bedrock.length = 0;
  rec.anthropic = 0;
  rec.models.length = 0;
  rec.tools.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("SK_BEDROCK_REGION / SK_BEDROCK_MODEL_MAP unset", () => {
  it("SK's provider target is empty and SK goes where every other call goes", async () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    vi.stubEnv("BEDROCK_REGION", "us-east-1");
    expect(skProviderTarget()).toEqual({});
    expect(skRegionLabel()).toBe("us-east-1");
    await drain(new AnthropicProvider("claude-sonnet-5-5", skProviderTarget()));
    expect(rec.bedrock).toEqual([{ awsRegion: "us-east-1" }]);
    expect(rec.models).toEqual(["global.anthropic.claude-sonnet-5-5"]);
  });
});

describe("SK_BEDROCK_REGION + SK_BEDROCK_MODEL_MAP set", () => {
  beforeEach(() => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    vi.stubEnv("BEDROCK_REGION", "us-east-1");
    vi.stubEnv("SK_BEDROCK_REGION", "ap-southeast-2");
    vi.stubEnv("SK_BEDROCK_MODEL_MAP", SK_MAP);
  });

  it("SK's providers (Sonnet and the fast Haiku) use the SK region and the au profiles", async () => {
    expect(skRegionLabel()).toBe("ap-southeast-2");
    await drain(new AnthropicProvider("claude-sonnet-5-5", skProviderTarget()));
    await drain(new AnthropicProvider("claude-haiku-5-5", skProviderTarget()));
    expect(rec.bedrock).toEqual([{ awsRegion: "ap-southeast-2" }, { awsRegion: "ap-southeast-2" }]);
    expect(rec.models).toEqual(["au.anthropic.claude-sonnet-5-5", "au.anthropic.claude-haiku-5-5"]);
  });

  it("non-SK callers are unaffected: the app region and the global profiles", async () => {
    claudeClient();
    await drain(new AnthropicProvider("claude-sonnet-5-5"));
    expect(rec.bedrock).toEqual([{ awsRegion: "us-east-1" }, { awsRegion: "us-east-1" }]);
    expect(rec.models).toEqual(["global.anthropic.claude-sonnet-5-5"]);
  });

  it("a malformed SK map is ignored and logged; the region still applies", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("SK_BEDROCK_MODEL_MAP", "{nope");
    expect(skModelMap()).toEqual({});
    expect(skProviderTarget()).toEqual({ region: "ap-southeast-2" });
    await drain(new AnthropicProvider("claude-sonnet-5-5", skProviderTarget()));
    expect(rec.models).toEqual(["global.anthropic.claude-sonnet-5-5"]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("first-party API", () => {
  it("SK's settings have no effect: ids pass through, no region", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("SK_BEDROCK_REGION", "ap-southeast-2");
    vi.stubEnv("SK_BEDROCK_MODEL_MAP", SK_MAP);
    expect(skRegionLabel()).toBe("anthropic");
    await drain(new AnthropicProvider("claude-haiku-5-5", skProviderTarget()));
    expect(rec.anthropic).toBe(1);
    expect(rec.bedrock).toEqual([]);
    expect(rec.models).toEqual(["claude-haiku-5-5"]);
  });
});

describe("prompt caching on the provider", () => {
  it("the LAST tool carries the cache breakpoint, the others none", () => {
    const t = toAnthropicTools([
      { name: "a", description: "a", parameters: {} },
      { name: "b", description: "b", parameters: {} },
    ]);
    expect(t[0]).not.toHaveProperty("cache_control");
    expect(t[1]).toMatchObject({ name: "b", cache_control: { type: "ephemeral" } });
  });
  it("sends the cached tools and reports cache reads in done.usage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const out = await drain(new AnthropicProvider("claude-haiku-5-5"), true);
    expect((rec.tools[0] as Array<Record<string, unknown>>)[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(out.at(-1)).toEqual({ type: "done", usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 } });
  });
});
