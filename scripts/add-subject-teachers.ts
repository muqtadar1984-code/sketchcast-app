/**
 * Add one dedicated teacher per enrichment subject to an EXISTING demo tenant —
 * additive, no wipe: the seeded classes, grid, books and absences all stay.
 *
 *   npx tsx scripts/add-subject-teachers.ts --slug demo
 *
 * Creates teacher6..teacherN@{slug}.sketchcast.app (shared password, same as
 * the seeder) with role=teacher, school membership, and onboarding
 * profile.subjects set — so the Auto-generate mapping pre-selects them and the
 * substitution picker ranks them as subject teachers. They own no classes and
 * hold no timetable slots, which is the point: staff with FREE capacity.
 *
 * Idempotent: an email that already exists in auth is skipped.
 * Requires ALLOW_SEED=true (env or .env.local), same guard as the seeder.
 *
 * NOTE: seed-school.ts creates these same six on a full re-seed — keep the
 * SUBJECT_TEACHERS list here and there in sync.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

function readEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

const fileEnv = readEnvFile(".env.local");
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
const ALLOW = (process.env.ALLOW_SEED || fileEnv.ALLOW_SEED) === "true";
const SLUG = (arg("slug") || "").toLowerCase();
const PASSWORD = arg("password") || "SketchDemo2026";

function fail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}
if (!URL || !SERVICE_KEY) fail("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (env or .env.local).");
if (!ALLOW) fail("ALLOW_SEED=true is required (writes accounts into a tenant).");
if (!SLUG) fail("--slug is required (e.g. --slug demo).");

const db: SupabaseClient = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// One teacher per enrichment subject. Numbering continues after the seeder's
// teacher1..teacher5.
export const SUBJECT_TEACHERS = [
  { fullName: "Farah Aziz", subject: "Art" },
  { fullName: "Zainab Ismail", subject: "Bahasa Melayu" },
  { fullName: "Kelvin Ong", subject: "ICT" },
  { fullName: "Anitha Ramasamy", subject: "Moral Education" },
  { fullName: "Hafiz Osman", subject: "Music" },
  { fullName: "Ganesh Muthu", subject: "PE" },
];
const FIRST_INDEX = 6;

async function main() {
  const { data: school } = await db.from("schools").select("id, name").eq("slug", SLUG).maybeSingle();
  if (!school) fail(`no school with slug "${SLUG}"`);
  console.log(`School: ${school.name} (${school.id})`);

  // Existing auth emails, paged (the project is small; fine to sweep).
  const existing = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`listUsers: ${error.message}`);
    for (const u of data.users) existing.add((u.email || "").toLowerCase());
    if (data.users.length < 200) break;
  }

  for (let i = 0; i < SUBJECT_TEACHERS.length; i++) {
    const t = SUBJECT_TEACHERS[i];
    const email = `teacher${FIRST_INDEX + i}@${SLUG}.sketchcast.app`;
    if (existing.has(email)) {
      console.log(`= ${email} already exists — skipped`);
      continue;
    }
    const { data, error } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: t.fullName, role: "teacher" },
    });
    if (error || !data?.user) fail(`createUser ${email}: ${error?.message ?? "no user"}`);
    // handle_new_user() pre-creates the profile row → UPDATE it.
    const { error: pErr } = await db
      .from("profiles")
      .update({
        role: "teacher",
        full_name: t.fullName,
        school_id: school.id,
        must_reset_password: false,
        onboarded_at: new Date().toISOString(),
        max_books: 20,
        profile: { subjects: [t.subject] },
      })
      .eq("id", data.user.id);
    if (pErr) fail(`profile ${email}: ${pErr.message}`);
    console.log(`+ ${t.fullName} — ${t.subject} — ${email}`);
  }
  console.log(`\nDone. Shared password: ${PASSWORD}`);
}

main().catch((e) => fail(String(e)));
