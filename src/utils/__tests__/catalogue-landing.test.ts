/**
 * The nudge that keeps sketchcast.app/topics in step with the catalogue: a
 * `repository_dispatch` to sketchcast-landing after a console action that
 * changes what public_catalogue() shows. It must be dormant without a token,
 * send exactly the documented event with nothing identifying in the payload,
 * and never throw — the member's action already happened.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-landing.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANDING_REBUILD_EVENT, landingRebuildConfigured, requestLandingRebuild } from "@/utils/catalogue/landing";

const TOKEN = "github_pat_test_token_long_enough";

function fetchAnswering(status: number, body = "") {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    // GitHub answers 204 No Content; a Response with a null-body status
    // must be built with a null body.
    return new Response(body || null, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

afterEach(() => {
  delete process.env.GITHUB_LANDING_TOKEN;
  vi.restoreAllMocks();
});

describe("requestLandingRebuild", () => {
  it("is dormant without a token: nothing is sent", async () => {
    const { f, calls } = fetchAnswering(204);
    expect(landingRebuildConfigured()).toBe(false);
    expect(await requestLandingRebuild("topic_retire", f)).toEqual({ ok: false, unconfigured: true });
    expect(calls).toHaveLength(0);
  });

  it("treats a blank or too-short token as unset", async () => {
    process.env.GITHUB_LANDING_TOKEN = "short";
    const { f, calls } = fetchAnswering(204);
    expect(landingRebuildConfigured()).toBe(false);
    expect(await requestLandingRebuild("kit_approve", f)).toEqual({ ok: false, unconfigured: true });
    expect(calls).toHaveLength(0);
  });

  it("sends the documented event to the landing repo, with only a reason and a time", async () => {
    process.env.GITHUB_LANDING_TOKEN = TOKEN;
    const { f, calls } = fetchAnswering(204);
    expect(landingRebuildConfigured()).toBe(true);
    expect(await requestLandingRebuild("topic_retire", f)).toEqual({ ok: true, status: 204 });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe("https://api.github.com/repos/muqtadar1984-code/sketchcast-landing/dispatches");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Accept).toBe("application/vnd.github+json");
    const body = JSON.parse(String(init.body));
    expect(body.event_type).toBe(LANDING_REBUILD_EVENT);
    expect(body.event_type).toBe("catalogue-changed");
    // The landing repo is public and so are its workflow runs: the payload
    // carries no id, title or member — the reason word and a timestamp only.
    expect(Object.keys(body.client_payload).sort()).toEqual(["at", "reason"]);
    expect(body.client_payload.reason).toBe("topic_retire");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a refusal with its status and never throws", async () => {
    process.env.GITHUB_LANDING_TOKEN = TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { f } = fetchAnswering(403, "Resource not accessible by personal access token");
    const r = await requestLandingRebuild("topic_merge", f);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.error).toContain("not accessible");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("swallows a network failure or timeout", async () => {
    process.env.GITHUB_LANDING_TOKEN = TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => {
      throw new Error("TimeoutError: signal timed out");
    }) as unknown as typeof fetch;
    const r = await requestLandingRebuild("questions_approve", f);
    expect(r).toEqual({ ok: false, error: "TimeoutError: signal timed out" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
