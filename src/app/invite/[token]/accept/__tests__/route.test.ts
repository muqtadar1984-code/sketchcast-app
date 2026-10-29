/**
 * /invite/[token]/accept — the school parent-invite path: children mapped in
 * invite_children become source='school' parent_links, re-validated at accept
 * time, verified only when the invite email matches the child's parent_email.
 * A failed mapping read or link write must leave the invite OPEN (prod ran
 * without 0019's invite_children table, which the route used to swallow).
 *
 * Run: npx vitest run "src/app/invite/[token]/accept/__tests__/route.test.ts"
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { GET } from "@/app/invite/[token]/accept/route";

type Row = Record<string, unknown>;
type Err = { code: string; message: string } | null;

const SCHOOL = "school-1";
const PARENT_EMAIL = "mum@home.my";

function fakeAdmin(cfg: {
  invite?: Row | null;
  profiles: Record<string, Row>;
  mapping?: Row[];
  mappingError?: Err;
  linkError?: Err;
}) {
  const writes: { table: string; op: "update" | "upsert"; values: Row }[] = [];
  const client = {
    from(table: string) {
      let op: "select" | "update" | "upsert" = "select";
      let id: unknown = null;
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (col: string, v: unknown) => {
          if (col === "id") id = v;
          return b;
        },
        update: (values: Row) => {
          op = "update";
          writes.push({ table, op, values });
          return b;
        },
        upsert: (values: Row) => {
          op = "upsert";
          writes.push({ table, op, values });
          return b;
        },
        maybeSingle: async () => {
          if (table === "invites") return { data: cfg.invite ?? null, error: null };
          if (table === "profiles") return { data: cfg.profiles[String(id)] ?? null, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === "invite_children" && op === "select") {
            return resolve(
              cfg.mappingError
                ? { data: null, error: cfg.mappingError }
                : { data: cfg.mapping ?? [], error: null },
            );
          }
          if (table === "parent_links") return resolve({ data: null, error: cfg.linkError ?? null });
          // books / classes footprint counts and every update
          return resolve({ data: null, count: 0, error: null });
        },
      });
      return b;
    },
  };
  return { client, writes };
}

function parentInvite(over: Row = {}): Row {
  return {
    id: "inv-1",
    email: PARENT_EMAIL,
    role: "parent",
    school_id: SCHOOL,
    token: "tok",
    invited_by: "admin-1",
    accepted_at: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  };
}

const student = (over: Row = {}): Row => ({
  role: "student",
  school_id: SCHOOL,
  parent_email: PARENT_EMAIL,
  ...over,
});

async function accept() {
  const res = await GET(new Request("http://localhost/invite/tok/accept"), {
    params: Promise.resolve({ token: "tok" }),
  });
  return res.headers.get("location");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "parent-1", email: "Mum@Home.my" } } }) },
  });
});

describe("parent invite accept", () => {
  it("links each still-valid mapped child as source='school' and redeems the invite", async () => {
    const admin = fakeAdmin({
      invite: parentInvite(),
      profiles: {
        "parent-1": { role: "teacher", school_id: null },
        "kid-a": student(),
        "kid-b": student({ parent_email: "someone.else@home.my" }),
        "kid-moved": student({ school_id: "school-2" }),
      },
      mapping: [{ student_id: "kid-a" }, { student_id: "kid-b" }, { student_id: "kid-moved" }],
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    expect(await accept()).toBe("http://localhost/dashboard/children");

    const links = admin.writes.filter((w) => w.table === "parent_links");
    expect(links.map((l) => l.values.child_id)).toEqual(["kid-a", "kid-b"]);
    for (const l of links) {
      expect(l.values).toMatchObject({ parent_id: "parent-1", source: "school", created_by: "admin-1" });
    }
    // Verified only where the child's parent_email is the invited address.
    expect(links[0].values.verified_at).toEqual(expect.any(String));
    expect(links[1].values.verified_at).toBeNull();
    // A fresh default account with no teaching footprint becomes a parent.
    expect(admin.writes).toContainEqual({ table: "profiles", op: "update", values: { role: "parent" } });
    expect(
      admin.writes.some((w) => w.table === "invites" && w.values.accepted_at),
    ).toBe(true);
  });

  it("leaves the invite open and changes nothing when the mapping cannot be read", async () => {
    const admin = fakeAdmin({
      invite: parentInvite(),
      profiles: { "parent-1": { role: "teacher", school_id: null } },
      mappingError: { code: "42P01", message: 'relation "public.invite_children" does not exist' },
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    expect(await accept()).toBe("http://localhost/invite/tok?e=apply");
    expect(admin.writes).toEqual([]);
  });

  it("leaves the invite open when a parent link cannot be written", async () => {
    const admin = fakeAdmin({
      invite: parentInvite(),
      profiles: { "parent-1": { role: "parent", school_id: null }, "kid-a": student() },
      mapping: [{ student_id: "kid-a" }],
      linkError: { code: "23514", message: "check violation" },
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    expect(await accept()).toBe("http://localhost/invite/tok?e=apply");
    expect(admin.writes.some((w) => w.table === "invites")).toBe(false);
  });

  it("refuses a student account before touching anything", async () => {
    const admin = fakeAdmin({
      invite: parentInvite(),
      profiles: { "parent-1": { role: "student", school_id: SCHOOL } },
      mapping: [{ student_id: "kid-a" }],
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    expect(await accept()).toBe("http://localhost/invite/tok?e=role");
    expect(admin.writes).toEqual([]);
  });
});
