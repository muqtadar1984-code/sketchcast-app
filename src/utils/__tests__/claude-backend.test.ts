// CLAUDE_BACKEND switch: which client the factory builds, which model id goes on
// the wire, and whether a route believes Claude is configured — on both backends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ anthropic: [] as unknown[], bedrock: [] as unknown[] }));
// The Vercel OIDC → STS exchange: each awsCredentialsProvider() init is recorded,
// and every provider it hands out calls `oidc.assume` (one STS round trip).
const oidc = vi.hoisted(() => ({ inits: [] as unknown[], assume: vi.fn() }));

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

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({
  awsCredentialsProvider: (init: unknown) => {
    oidc.inits.push(init);
    return () => oidc.assume();
  },
}));

import {
  BEDROCK_MODEL_IDS,
  claudeBackend,
  claudeClient,
  claudeConfigured,
  claudeModel,
  resetBedrockCredentialCache,
} from "../claude-backend";

const VARS = [
  "CLAUDE_BACKEND",
  "ANTHROPIC_API_KEY",
  "BEDROCK_REGION",
  "BEDROCK_MODEL_MAP",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
] as const;

beforeEach(() => {
  for (const v of VARS) vi.stubEnv(v, "");
  built.anthropic.length = 0;
  built.bedrock.length = 0;
  oidc.inits.length = 0;
  oidc.assume.mockReset();
  resetBedrockCredentialCache();
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
    // The worker's two current models (SK B0) — same profiles as shared/claude_client.py.
    expect(claudeModel("claude-sonnet-5-5")).toBe("global.anthropic.claude-sonnet-5-5");
    expect(claudeModel("claude-haiku-5-5")).toBe("global.anthropic.claude-haiku-5-5");
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

describe("claudeClient on Bedrock with AWS_ROLE_ARN (Vercel OIDC)", () => {
  const ROLE = "arn:aws:iam::172042957848:role/sketchcast-vercel-bedrock";
  type Opts = { awsRegion: string; providerChainResolver?: () => Promise<() => Promise<unknown>> };
  const lastOpts = () => built.bedrock.at(-1) as Opts;
  const resolveCreds = async () => (await lastOpts().providerChainResolver!())();
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);
  const roleCreds = (expiration: Date) => ({ accessKeyId: "ASIAROLE", secretAccessKey: "s", sessionToken: "t", expiration });

  beforeEach(() => {
    vi.stubEnv("CLAUDE_BACKEND", "bedrock");
  });

  it("without a role, passes no resolver — the SDK's default chain reads static keys", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIASTATIC");
    claudeClient();
    expect(built.bedrock).toEqual([{ awsRegion: "us-east-1" }]);
    expect(oidc.inits).toHaveLength(0);
  });

  it("with a role, hands Bedrock a resolver that assumes it via OIDC in the Bedrock region", async () => {
    vi.stubEnv("AWS_ROLE_ARN", `  ${ROLE} `);
    vi.stubEnv("BEDROCK_REGION", "us-west-2");
    oidc.assume.mockResolvedValue(roleCreds(inMinutes(60)));
    claudeClient();
    expect(lastOpts().awsRegion).toBe("us-west-2");
    expect(typeof lastOpts().providerChainResolver).toBe("function");
    await expect(resolveCreds()).resolves.toMatchObject({ accessKeyId: "ASIAROLE", sessionToken: "t" });
    expect(oidc.inits).toEqual([{ roleArn: ROLE, roleSessionName: "sketchcast-app", clientConfig: { region: "us-west-2" } }]);
  });

  it("caches role credentials across requests and clients until near expiry", async () => {
    vi.stubEnv("AWS_ROLE_ARN", ROLE);
    oidc.assume.mockResolvedValueOnce(roleCreds(inMinutes(60)));
    claudeClient();
    await resolveCreds();
    claudeClient(); // a new client (a new request) shares the instance's cache
    await resolveCreds();
    expect(oidc.assume).toHaveBeenCalledTimes(1);
  });

  it("re-assumes when cached credentials are within five minutes of expiry", async () => {
    vi.stubEnv("AWS_ROLE_ARN", ROLE);
    oidc.assume.mockResolvedValueOnce(roleCreds(inMinutes(4))).mockResolvedValueOnce({
      ...roleCreds(inMinutes(60)),
      accessKeyId: "ASIAFRESH",
    });
    claudeClient();
    await resolveCreds();
    await expect(resolveCreds()).resolves.toMatchObject({ accessKeyId: "ASIAFRESH" });
    expect(oidc.assume).toHaveBeenCalledTimes(2);
  });

  it("shares one STS exchange between concurrent requests", async () => {
    vi.stubEnv("AWS_ROLE_ARN", ROLE);
    let release!: (v: unknown) => void;
    oidc.assume.mockReturnValueOnce(new Promise((r) => (release = r)));
    claudeClient();
    const both = Promise.all([resolveCreds(), resolveCreds()]);
    release(roleCreds(inMinutes(60)));
    const [a, b] = await both;
    expect(a).toBe(b);
    expect(oidc.assume).toHaveBeenCalledTimes(1);
  });

  it("falls back to static keys (logged) when the role exchange fails", async () => {
    vi.stubEnv("AWS_ROLE_ARN", ROLE);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIASTATIC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "static-secret");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    oidc.assume.mockRejectedValue(new Error("The 'x-vercel-oidc-token' header is missing"));
    claudeClient();
    await expect(resolveCreds()).resolves.toEqual({ accessKeyId: "AKIASTATIC", secretAccessKey: "static-secret" });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/OIDC/), expect.any(Error));
    err.mockRestore();
  });

  it("carries AWS_SESSION_TOKEN on the static fallback", async () => {
    vi.stubEnv("AWS_ROLE_ARN", ROLE);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "ASIATEMP");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "temp-secret");
    vi.stubEnv("AWS_SESSION_TOKEN", "temp-token");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    oidc.assume.mockRejectedValue(new Error("AccessDenied"));
    claudeClient();
    await expect(resolveCreds()).resolves.toEqual({
      accessKeyId: "ASIATEMP",
      secretAccessKey: "temp-secret",
      sessionToken: "temp-token",
    });
    err.mockRestore();
  });

  it("surfaces the failure when there are no static keys to fall back on, and retries next time", async () => {
    vi.stubEnv("AWS_ROLE_ARN", ROLE);
    oidc.assume.mockRejectedValueOnce(new Error("AccessDenied")).mockResolvedValueOnce(roleCreds(inMinutes(60)));
    claudeClient();
    await expect(resolveCreds()).rejects.toThrow(/AccessDenied/);
    await expect(resolveCreds()).resolves.toMatchObject({ accessKeyId: "ASIAROLE" }); // a failure is never cached
  });
});
