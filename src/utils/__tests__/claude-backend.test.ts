// CLAUDE_BACKEND switch: which client the factory builds, which model id goes on
// the wire, and whether a route believes Claude is configured — on both backends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ anthropic: [] as unknown[], bedrock: [] as unknown[] }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: vi.fn(), stream: vi.fn() };
    constructor(opts: unknown) {
      built.anthropic.push(opts);
    }
  },
}));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  AnthropicBedrock: class FakeBedrock {
    messages = { create: vi.fn(), stream: vi.fn() };
    constructor(opts: unknown) {
      built.bedrock.push(opts);
    }
  },
}));

import { BEDROCK_MODEL_IDS, claudeBackend, claudeClient, claudeConfigured, claudeModel } from "../claude-backend";

const VARS = [
  "CLAUDE_BACKEND",
  "ANTHROPIC_API_KEY",
  "BEDROCK_REGION",
  "BEDROCK_MODEL_MAP",
  "AWS_ACCESS_KEY_ID",
  "AWS_ROLE_ARN",
] as const;

beforeEach(() => {
  for (const v of VARS) vi.stubEnv(v, "");
  built.anthropic.length = 0;
  built.bedrock.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claudeBackend", () => {
  it("defaults to the first-party API", () => {
    expect(claudeBackend()).toBe("anthropic");
  });
  it("is bedrock only for CLAUDE_BACKEND=bedrock (any case, trimmed)", () => {
    vi.stubEnv("CLAUDE_BACKEND", " Bedrock ");
    expect(claudeBackend()).toBe("bedrock");
    vi.stubEnv("CLAUDE_BACKEND", "vertex");
    expect(claudeBackend()).toBe("anthropic");
  });
});

describe("claudeClient (factory selection)", () => {
  it("builds the first-party client on ANTHROPIC_API_KEY by default", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const c = claudeClient();
    expect(built.anthropic).toEqual([{ apiKey: "sk-test" }]);
    expect(built.bedrock).toHaveLength(0);
    expect(typeof c.messages.create).toBe("function");
    expect(typeof c.messages.stream).toBe("function");
  });

  it("throws on the first-party API without a key", () => {
    expect(() => claudeClient()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds the Bedrock client in us-east-1 by default, needing no Anthropic key", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    const c = claudeClient();
    expect(built.bedrock).toEqual([{ awsRegion: "us-east-1" }]);
    expect(built.anthropic).toHaveLength(0);
    expect(typeof c.messages.create).toBe("function");
    expect(typeof c.messages.stream).toBe("function");
  });

  it("honours BEDROCK_REGION", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    vi.stubEnv("BEDROCK_REGION", "us-west-2");
    claudeClient();
    expect(built.bedrock).toEqual([{ awsRegion: "us-west-2" }]);
  });
});

describe("claudeModel (id mapping)", () => {
  it("passes every id through unchanged on the first-party API", () => {
    for (const id of Object.keys(BEDROCK_MODEL_IDS)) expect(claudeModel(id)).toBe(id);
  });

  it("maps first-party ids to the global inference profiles on Bedrock", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    expect(claudeModel("claude-haiku-4-5")).toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(claudeModel("claude-haiku-4-5-20251001")).toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(claudeModel("claude-sonnet-4-6")).toBe("global.anthropic.claude-sonnet-4-6");
    expect(claudeModel("claude-sonnet-5")).toBe("global.anthropic.claude-sonnet-5");
  });

  it("passes an unmapped or already-Bedrock id through", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    expect(claudeModel("us.anthropic.claude-sonnet-5")).toBe("us.anthropic.claude-sonnet-5");
    expect(claudeModel("claude-opus-9")).toBe("claude-opus-9");
  });

  it("overlays BEDROCK_MODEL_MAP on the built-in table", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    vi.stubEnv(
      "BEDROCK_MODEL_MAP",
      JSON.stringify({ "claude-sonnet-5": "us.anthropic.claude-sonnet-5", "claude-opus-5-5": "global.anthropic.claude-opus-5-5" }),
    );
    expect(claudeModel("claude-sonnet-5")).toBe("us.anthropic.claude-sonnet-5"); // overridden
    expect(claudeModel("claude-opus-5-5")).toBe("global.anthropic.claude-opus-5-5"); // added
    expect(claudeModel("claude-sonnet-4-6")).toBe("global.anthropic.claude-sonnet-4-6"); // untouched
  });

  it("ignores the overlay off Bedrock", () => {
    vi.stubEnv("BEDROCK_MODEL_MAP", JSON.stringify({ "claude-sonnet-5": "x" }));
    expect(claudeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("falls back to the built-in table when BEDROCK_MODEL_MAP is malformed", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of ["{not json", "[]", '"str"']) {
      vi.stubEnv("BEDROCK_MODEL_MAP", bad);
      expect(claudeModel("claude-sonnet-5")).toBe("global.anthropic.claude-sonnet-5");
    }
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("claudeConfigured", () => {
  it("first-party: true only with ANTHROPIC_API_KEY", () => {
    expect(claudeConfigured()).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(claudeConfigured()).toBe(true);
  });

  it("bedrock: AWS credentials count, the Anthropic key does not", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(claudeConfigured()).toBe(false);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIATEST");
    expect(claudeConfigured()).toBe(true);
  });

  it("bedrock: a role to assume (OIDC) counts", () => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::000000000000:role/test");
    expect(claudeConfigured()).toBe(true);
  });
});
