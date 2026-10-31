// Every SK entry point applies the allow-list gate (founder 2026-10-30: SK only
// for the founder, Sara, and Sara's students until he clears it for release).
//
// Table-driven over the FILESYSTEM, not a hand list: every route.ts under
// src/app/api/sk is imported and each exported HTTP handler is called as a
// signed-in user the allow-list refuses. Each must answer 404 (exactly what a
// non-allowed user saw before) and no model provider may be constructed. A new
// route is in the table the moment it exists; the only way out is the short
// EXEMPT list below, each with its reason. The /sk pages and /activate are
// called the same way and must notFound(); the layouts and the header that
// mount SK are pinned by a synchronous source scan.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { __setSkAccessAdminForTests } from "@/sk/access-gate";
import { ACCESS_ENV, FOUNDER_STUDENT, RANDOM_TEACHER, SARA_STUDENT, accessFake } from "@/sk/__tests__/access-fixture";

const mocks = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  role: null as string | null,
  constructed: 0,
}));

function chain(): unknown {
  const empty = { data: null, error: null, count: 0 };
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
      if (prop === "maybeSingle" || prop === "single") {
        return async () => ({ data: mocks.user ? { role: mocks.role, school_id: null, full_name: "x" } : null, error: null });
      }
      if (prop === "rpc") return async () => empty;
      return () => proxy;
    },
  };
  const proxy: object = new Proxy({}, handler);
  return proxy;
}

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: () => chain(),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => chain(), rpc: async () => ({ data: null, error: null }), storage: { from: () => chain() } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
// The pages read the dictionary only AFTER the gate; "server-only" (imported by
// the real module) does not resolve under vitest.
vi.mock("@/i18n/dictionaries", () => ({ getDictionary: async () => new Proxy({}, { get: () => ({}) }) }));
vi.mock("@/i18n/resolve", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/utils/assistant/providers/anthropic", () => ({
  AnthropicProvider: class {
    constructor() {
      mocks.constructed++;
    }
  },
}));

// The first import of each route transforms its whole graph.
vi.setConfig({ testTimeout: 120_000 });

const ROOT = resolve(__dirname, "../../../../..");
const SRC = join(ROOT, "src");
const API_SK = join(SRC, "app/api/sk");

/** Session-gated settings controls on /dashboard/settings (a non-SK page every
 *  signed-in user sees). They serve no SK content and call no model; each is
 *  scoped to the caller's own rows (or a verified child's / a principal's
 *  school) by its own checks. Gating them would break the settings page for
 *  everyone off the list and — worse — block deleting your own SK memory. */
const EXEMPT: Record<string, string> = {
  "memory/route.ts": "DELETE your own (or a verified child's) SK memory must work whether or not SK is on for you",
  "consent/route.ts": "a parent revoking SK consent for a child (revocation deletes data) must always work",
  "prefs/route.ts": "three booleans on /dashboard/settings, the caller's own rows through RLS",
  "school-memory/route.ts": "the principal's learning-memory switch on /dashboard/settings",
  "gaps/nightly/route.ts": "Vercel Cron only (Bearer CRON_SECRET, no user session): 401 to every caller without the secret, before any read or model call",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const routeFiles = walk(API_SK)
  .map((f) => relative(API_SK, f).replace(/\\/g, "/"))
  .sort();
const gated = routeFiles.filter((f) => !EXEMPT[f]);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const ENV: Record<string, string> = {
  ...ACCESS_ENV,
  FEATURE_SK: "true",
  NEXT_PUBLIC_FEATURE_SK: "true",
  SK_ROLES: "teacher,student,parent,school_admin,coordinator",
  SK_TTS: "polly",
  SK_STT: "transcribe",
  SK_SHELL_SECRET: "sk-access-gate-test-secret-0123456789",
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  for (const k of ["FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __setSkAccessAdminForTests(null);
});
beforeEach(() => {
  const fake = accessFake();
  __setSkAccessAdminForTests(() => fake.admin);
  mocks.constructed = 0;
});

const REFUSED = [
  { who: "a random teacher", user: RANDOM_TEACHER, role: "teacher" },
  { who: "the founder's own student", user: FOUNDER_STUDENT, role: "student" },
];

function requestFor(method: string, file: string): Request {
  const url = `https://app.example.test/api/sk/${file.replace(/\/?route\.ts$/, "").replace(/\[id\]/, "00000000-0000-4000-8000-000000000001")}?product=p&chapter=1`;
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "DELETE") init.body = JSON.stringify({ product: "p", chapter: "1", text: "hi", message: "hi" });
  return new Request(url, init);
}

describe("the SK route inventory", () => {
  it("finds the routes (the walker is not vacuous) and every exemption still exists", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(20);
    for (const f of Object.keys(EXEMPT)) expect(routeFiles, f).toContain(f);
  });

  it("each gated route reaches the gate in its source (gate(), skShellEnabledFor or skAccessAllowed)", () => {
    for (const f of gated) {
      const text = readFileSync(join(API_SK, f), "utf8");
      expect(text, f).toMatch(/\bgate\(\)|skShellEnabledFor\(|skAccessAllowed\(/);
      expect(text, `${f} must not rely on the email-only gate`).not.toMatch(/skUserAllowed\(/);
    }
  });
});

describe.each(REFUSED)("every SK route refuses $who with 404", ({ user, role }) => {
  it.each(gated)("%s", async (file) => {
    mocks.user = user;
    mocks.role = role;
    const mod = (await import(/* @vite-ignore */ `@/app/api/sk/${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    const handlers = METHODS.filter((m) => typeof mod[m] === "function");
    expect(handlers.length, file).toBeGreaterThan(0);
    for (const m of handlers) {
      const res = (await (mod[m] as (r: Request, ctx: unknown) => Promise<Response>)(requestFor(m, file), {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
      })) as Response;
      expect(res.status, `${m} ${file}`).toBe(404);
    }
    expect(mocks.constructed, `${file} constructed a model provider`).toBe(0);
  });
});

describe("anonymous callers are refused too", () => {
  it.each(gated)("%s", async (file) => {
    mocks.user = null;
    mocks.role = null;
    const mod = (await import(/* @vite-ignore */ `@/app/api/sk/${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    for (const m of METHODS.filter((k) => typeof mod[k] === "function")) {
      const res = (await (mod[m] as (r: Request, ctx: unknown) => Promise<Response>)(requestFor(m, file), {
        params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
      })) as Response;
      // 404 from gate(); the Shell routes answered 401 "Not signed in" before
      // this change too. Either way nothing SK runs.
      expect([401, 404], `${m} ${file}`).toContain(res.status);
    }
    expect(mocks.constructed).toBe(0);
  });
});

describe("the shared route gate admits Sara's student", () => {
  it("gate() → ok for an enrolled student with no address", async () => {
    mocks.user = SARA_STUDENT;
    mocks.role = "student";
    const { gate } = await import("@/sk/server");
    const g = await gate();
    expect(g.ok).toBe(true);
  });
});

// The /sk pages (SK Tutor) are retired (2026-10-31): they only redirect
// (src/app/sk/redirect-path.ts, tested there) and render no SK at all.
const PAGES: Array<{ name: string; load: () => Promise<{ default: (props: never) => Promise<unknown> }>; props: unknown }> = [
  { name: "/activate", load: () => import("@/app/activate/page"), props: {} },
];

describe.each(REFUSED)("every SK page is notFound() for $who", ({ user, role }) => {
  it.each(PAGES.map((p) => [p.name, p] as const))("%s", async (_name, page) => {
    mocks.user = user;
    mocks.role = role;
    const mod = await page.load();
    await expect(mod.default(page.props as never)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the surfaces that mount SK await the async gate (source scan)", () => {
  // Synchronous walk of the files that decide whether SK appears at all.
  const SURFACES: Record<string, RegExp> = {
    "src/app/dashboard/layout.tsx": /skShellEnabledFor\(/, // the Shell launcher (teachers, parents, …)
    "src/app/console/layout.tsx": /skShellEnabledFor\(/,
    "src/app/present/page.tsx": /skShellEnabledFor\(|skAccessAllowed\(/, // the Board's Shell + its tab row
    "src/app/activate/page.tsx": /skAccessAllowed\(/,
    "src/sk/server.ts": /skAccessAllowed\(/,
  };
  it.each(Object.entries(SURFACES))("%s", (file, re) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).toMatch(re);
    expect(text, `${file} must not gate SK on the email-only skUserAllowed`).not.toMatch(/skUserAllowed\(/);
  });

  it("no module outside flags.ts calls the email-only skUserAllowed", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "__tests__" || name === "node_modules") continue;
        if (statSync(p).isDirectory()) scan(p);
        else if (/\.(ts|tsx)$/.test(name) && !p.endsWith(join("utils", "flags.ts")) && /skUserAllowed\(/.test(readFileSync(p, "utf8"))) offenders.push(relative(ROOT, p));
      }
    };
    scan(SRC);
    expect(offenders).toEqual([]);
  });
});
