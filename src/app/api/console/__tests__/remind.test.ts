/**
 * /api/console/remind — manual lifecycle nudge: staff gate, teacher-only,
 * nothing-to-remind, opt-out, and the 3-day cooldown (which an AUTOMATED
 * lifecycle send also triggers — founder's rule).
 *
 * Run: npx vitest run src/app/api/console/__tests__/remind.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPlatformAdminRequest: vi.fn(),
  createAdminClient: vi.fn(),
  sendLifecycleEmail: vi.fn(),
}));

vi.mock("@/utils/platform-admin", () => ({ isPlatformAdminRequest: mocks.isPlatformAdminRequest }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/lifecycle/send", () => ({
  sendLifecycleEmail: mocks.sendLifecycleEmail,
  lifecycleAppUrl: () => "https://app.sketchcast.app",
  lifecycleReplyTo: () => "muqtadar.quraishi@sketchcast.app",
  LIFECYCLE_FROM: "SketchCast <noreply@sketchcast.app>",
}));

import { POST } from "@/app/api/console/remind/route";

type Row = Record<string, unknown>;

function fakeAdmin(cfg: {
  profile?: Row | null;
  books?: Row[];
  generations?: Row[];
  consoleReminders?: Row[];
  lifecycleEmails?: Row[];
  email?: string | null;
}) {
  const inserts: { table: string; values: Row }[] = [];
  const rowsFor = (table: string): Row[] | null => {
    if (table === "books") return cfg.books ?? [];
    if (table === "generations") return cfg.generations ?? [];
    if (table === "console_reminders") return cfg.consoleReminders ?? [];
    if (table === "lifecycle_emails") return cfg.lifecycleEmails ?? [];
    return null;
  };
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        is: () => b,
        gte: () => b,
        order: () => b,
        limit: () => b,
        insert: (values: Row) => {
          inserts.push({ table, values });
          return b;
        },
        maybeSingle: async () => ({
          data: table === "profiles" ? cfg.profile ?? null : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => resolve({ data: rowsFor(table), error: null }),
      });
      return b;
    },
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: cfg.email === null ? null : { email: cfg.email ?? "sara@school.my" } },
        }),
      },
    },
  };
  return { client, inserts };
}

function teacher(over: Row = {}): Row {
  return { id: "u1", full_name: "Sara Binti Ahmad", role: "teacher", email_optout_at: null, is_demo: false, ...over };
}

function req(body: unknown) {
  return new Request("http://localhost/api/console/remind", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LIFECYCLE_TOKEN_SECRET", "test-secret");
  mocks.isPlatformAdminRequest.mockResolvedValue({ id: "staff-1", email: "staff@sketchcast.app" });
  mocks.sendLifecycleEmail.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/console/remind — refusals", () => {
  it("404s non-staff and sends nothing", async () => {
    mocks.isPlatformAdminRequest.mockResolvedValue(null);
    const { client, inserts } = fakeAdmin({ profile: teacher() });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(404);
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("400s a non-teacher — lifecycle mail is teacher-only (0080: students are minors)", async () => {
    const { client } = fakeAdmin({ profile: teacher({ role: "student" }) });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(400);
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("400s 'nothing to remind' when they have generation ATTEMPTS — any status", async () => {
    const { client } = fakeAdmin({
      profile: teacher(),
      books: [{ title: "Algebra I" }],
      generations: [{ id: "g1" }], // one FAILED attempt is still an attempt
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/nothing to remind/i);
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
  });

  it("400s an opted-out user — unsubscribe is absolute", async () => {
    const { client, inserts } = fakeAdmin({ profile: teacher({ email_optout_at: daysAgo(30) }) });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(400);
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("429s with a retry-after date when a MANUAL reminder is within 3 days", async () => {
    const sentAt = daysAgo(2);
    const { client, inserts } = fakeAdmin({
      profile: teacher(),
      consoleReminders: [{ sent_at: sentAt }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(429);
    const json = (await res.json()) as { retry_after?: string };
    expect(json.retry_after).toBe(new Date(new Date(sentAt).getTime() + 3 * DAY_MS).toISOString());
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("429s when an AUTOMATED lifecycle send is within 3 days — the founder's rule", async () => {
    const { client } = fakeAdmin({
      profile: teacher(),
      lifecycleEmails: [{ sent_at: daysAgo(1) }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(429);
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/remind — sends", () => {
  it("no books → sends the cron's no_book email and records segment no_upload", async () => {
    const { client, inserts } = fakeAdmin({ profile: teacher() });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { segment?: string }).segment).toBe("no_upload");

    // The SAME email the lifecycle cron sends — copy.ts's no_book template.
    const [to, subject, text] = mocks.sendLifecycleEmail.mock.calls[0] as [string, string, string];
    expect(to).toBe("sara@school.my");
    expect(subject).toBe("Your SketchCast account is ready — upload a textbook to start");
    expect(text).toContain("Hi Sara,");
    expect(text).toContain("/api/lifecycle/unsubscribe?t=");

    const marker = inserts.find((i) => i.table === "console_reminders");
    expect(marker?.values).toMatchObject({ user_id: "u1", segment: "no_upload", sent_by: "staff-1" });
    expect(inserts.some((i) => i.table === "platform_audit_log")).toBe(true);
  });

  it("books + zero attempts → no_generation email naming the newest book", async () => {
    const { client, inserts } = fakeAdmin({
      profile: teacher(),
      books: [{ title: "Form 4 Physics" }, { title: "Older Book" }],
    });
    mocks.createAdminClient.mockReturnValue(client);

    const res = await POST(req({ user_id: "u1" }));
    expect(res.status).toBe(200);

    const [, subject, text] = mocks.sendLifecycleEmail.mock.calls[0] as [string, string, string];
    expect(subject).toBe("Your textbook is ready — create your first lesson");
    expect(text).toContain('"Form 4 Physics"');

    const marker = inserts.find((i) => i.table === "console_reminders");
    expect(marker?.values).toMatchObject({ segment: "no_generation" });
  });

  it("a failed send records NOTHING — the button unblocks for a retry", async () => {
    mocks.sendLifecycleEmail.mockResolvedValue(false);
    const { client, inserts } = fakeAdmin({ profile: teacher() });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(502);
    expect(inserts).toHaveLength(0);
  });

  it("400s when the user has no email on file", async () => {
    const { client, inserts } = fakeAdmin({ profile: teacher(), email: null });
    mocks.createAdminClient.mockReturnValue(client);

    expect((await POST(req({ user_id: "u1" }))).status).toBe(400);
    expect(mocks.sendLifecycleEmail).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});
