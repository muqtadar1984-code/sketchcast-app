// The one-time welcome email: who qualifies, and the founder-approved copy.
// The claim-first send flow lives in maybeSendWelcomeEmail and is guarded by
// the ledger's unique (user_id, segment) — these tests pin the pure parts.

import { describe, it, expect } from "vitest";
import { shouldWelcome, firstNameOf, WELCOME_FROM } from "../lifecycle/welcome";
import { welcomeEmail } from "../lifecycle/copy";

const base = {
  role: "teacher",
  is_demo: false,
  email_optout_at: null,
  created_at: "2026-08-18T10:00:00Z",
  full_name: "Neda Mahini",
};

describe("shouldWelcome — who gets the one-time welcome", () => {
  it("a fresh teacher with an email qualifies", () => {
    expect(shouldWelcome(base, "t@example.com")).toBe(true);
  });

  it("parents and school admins qualify too — only students never do", () => {
    expect(shouldWelcome({ ...base, role: "parent" }, "p@example.com")).toBe(true);
    expect(shouldWelcome({ ...base, role: "school_admin" }, "a@example.com")).toBe(true);
    expect(shouldWelcome({ ...base, role: "student" }, "s@students.sketchcast.app")).toBe(false);
  });

  it("no email, opted out, and demo accounts are all skipped", () => {
    expect(shouldWelcome(base, null)).toBe(false);
    expect(shouldWelcome(base, "")).toBe(false);
    expect(shouldWelcome({ ...base, email_optout_at: "2026-08-01T00:00:00Z" }, "t@x.com")).toBe(false);
    expect(shouldWelcome({ ...base, is_demo: true }, "teacher1@demo.sketchcast.app")).toBe(false);
  });

  it("accounts created before the feature shipped are never welcomed retroactively", () => {
    expect(shouldWelcome({ ...base, created_at: "2026-08-01T00:00:00Z" }, "t@x.com")).toBe(false);
    expect(base.created_at >= WELCOME_FROM).toBe(true);
  });
});

describe("welcomeEmail — the founder-approved copy", () => {
  const mail = welcomeEmail({
    firstName: "Neda",
    appUrl: "https://app.sketchcast.app",
    unsubscribeUrl: "https://app.sketchcast.app/api/lifecycle/unsubscribe?t=tok",
  });

  it("subject and greeting", () => {
    expect(mail.subject).toBe("Your SketchCast account is ready");
    expect(mail.text).toContain("Hi Neda,");
  });

  it("carries the two-step start, the plain login link, and the reply invitation", () => {
    expect(mail.text).toContain("1. Upload your textbook");
    expect(mail.text).toContain("2. Pick a chapter and press Generate");
    expect(mail.text).toContain("Log in any time: https://app.sketchcast.app/login");
    expect(mail.text).toContain("a real person reads every reply");
    expect(mail.text).toContain("Unsubscribe: https://app.sketchcast.app/api/lifecycle/unsubscribe?t=tok");
  });

  it('the "(sent once)" note was removed on founder review', () => {
    expect(mail.text.toLowerCase()).not.toContain("sent once");
  });

  it("no name falls back to the neutral greeting", () => {
    expect(welcomeEmail({ firstName: null, appUrl: "x", unsubscribeUrl: "y" }).text).toContain("Hi there,");
  });
});

describe("firstNameOf", () => {
  it("takes the first word, handles empties", () => {
    expect(firstNameOf("Neda Mahini")).toBe("Neda");
    expect(firstNameOf("  ")).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});
