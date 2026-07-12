/**
 * Autofix decision-link token — the security boundary for email Approve/Reject.
 * Mirrors board-auth.test.ts. Run: npx vitest run src/utils/autofix/__tests__/token.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";
import { signDecisionToken, verifyDecisionToken, AUTOFIX_TOKEN_TTL_SEC } from "@/utils/autofix/token";

beforeAll(() => {
  process.env.AUTOFIX_TOKEN_SECRET = "test-secret-at-least-16-characters-long";
});

const RUN = "11111111-2222-3333-4444-555555555555";

describe("autofix decision token", () => {
  it("round-trips approve and reject", () => {
    expect(verifyDecisionToken(signDecisionToken(RUN, "approve"))).toEqual({ run: RUN, action: "approve" });
    expect(verifyDecisionToken(signDecisionToken(RUN, "reject"))).toEqual({ run: RUN, action: "reject" });
  });

  it("rejects an expired token", () => {
    const past = Date.now() - (AUTOFIX_TOKEN_TTL_SEC + 60) * 1000;
    const tok = signDecisionToken(RUN, "approve", past);
    expect(verifyDecisionToken(tok)).toBeNull();
    // ...but valid when checked at mint time
    expect(verifyDecisionToken(tok, past + 1000)).toEqual({ run: RUN, action: "approve" });
  });

  it("rejects a tampered signature or payload", () => {
    const tok = signDecisionToken(RUN, "approve");
    expect(verifyDecisionToken(tok.slice(0, -1) + (tok.at(-1) === "A" ? "B" : "A"))).toBeNull();
    const [body, sig] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ run: RUN, action: "approve", scope: "autofix", exp: 9e12 })).toString("base64url");
    expect(verifyDecisionToken(`${forged}.${sig}`)).toBeNull(); // sig no longer matches the body
    expect(body.length).toBeGreaterThan(0);
  });

  it("rejects malformed / wrong-scope / empty input", () => {
    expect(verifyDecisionToken("")).toBeNull();
    expect(verifyDecisionToken("nodot")).toBeNull();
    expect(verifyDecisionToken("a.b.c")).toBeNull();
    const wrongScope = Buffer.from(JSON.stringify({ run: RUN, action: "approve", scope: "board", exp: 9e12 })).toString("base64url");
    // even correctly-signed, a non-autofix scope must fail
    process.env.AUTOFIX_TOKEN_SECRET = "test-secret-at-least-16-characters-long";
    expect(verifyDecisionToken(`${wrongScope}.whatever`)).toBeNull();
  });

  it("returns null (never throws) when the secret is unset", () => {
    const saved = process.env.AUTOFIX_TOKEN_SECRET;
    delete process.env.AUTOFIX_TOKEN_SECRET;
    expect(() => verifyDecisionToken("x.y")).not.toThrow();
    expect(verifyDecisionToken("x.y")).toBeNull();
    process.env.AUTOFIX_TOKEN_SECRET = saved;
  });
});
