/**
 * Idempotent school-tenant seeder — wipes and rebuilds ONE school (and only that
 * school) as a complete, demonstrable workspace. "demo" is the canonical template
 * tenant; onboarding a real school is the same command with a different slug:
 *
 *   ALLOW_SEED=true npx tsx scripts/seed-school.ts --slug demo --name "Demo School" \
 *     --clone-from <email-of-book-owner> [--password SketchDemo2026] [--yes]
 *
 * What it builds: 1 principal (school_admin + a coordinator grant), 5 teachers
 * (one also holds a coordinator grant so the NAMED at-risk worklist is demoable),
 * 5 classes, 25 students, 1 parent linked to a student, a shared library cloned
 * from --clone-from's real indexed books (rows + storage files, so Watch / Deck /
 * Worksheet / Quiz actually open), assignments with mixed due dates, a spread of
 * student progress (completed / in-progress / revised / inactive / never-started),
 * submissions in every grade_status (the "To grade" queue is populated), and
 * deliberately shaped at-risk students so the leadership worklist is compelling.
 *
 * Safety model:
 *   - Requires ALLOW_SEED=true AND an explicit --slug AND (unless --yes) typing
 *     the slug back at the prompt after the target project ref is printed.
 *   - Requires migration 0042 (schools.slug) — aborts cleanly if missing.
 *   - The wipe deletes ONLY: profiles whose school_id = the slug's school, plus
 *     students enrolled in that school's classes (heals orphans from a failed
 *     run), plus adults whose email ends @{slug}.sketchcast.app (seeder-created
 *     principal/teachers/parent). Nothing else. Every DB delete is keyed to the
 *     resolved school id; auth deletes are keyed to that collected id set.
 *   - Demo-tenant convenience: every account gets must_reset_password=false and
 *     ONE shared documented password, because a salesperson logs in live during
 *     a pitch. The normal provisioning path keeps must_reset_password=true.
 *
 * Gotchas handled (learned from the real schema):
 *   - handle_new_user() pre-creates the profile on auth signup → we UPDATE it.
 *   - role/school_id/max_* are service-role-only columns (0010) → admin client.
 *   - effective_cap defaults to 1 book (0024) and the BEFORE triggers fire even
 *     under the service role → teachers get a max_books override BEFORE cloning.
 *   - books/generations INSERTs auto-enqueue worker jobs (0001/0002 triggers) →
 *     we close those jobs as 'done' immediately so the Railway worker never
 *     re-generates (and never re-indexes) cloned content.
 *   - student_progress has a BEFORE UPDATE touch trigger only → backdated
 *     updated_at values survive as long as we INSERT rows fully-formed.
 *   - Parents never get school_id (multi-school by design) → the demo parent is
 *     discovered for wipe by email domain, not school_id.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { studentEmail, usernameBase } from "../src/utils/student";

// ── Env + args ────────────────────────────────────────────────────────────────

function readEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
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
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const fileEnv = readEnvFile(".env.local");
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ALLOW = (process.env.ALLOW_SEED || fileEnv.ALLOW_SEED) === "true";

const SLUG = (arg("slug") || "").toLowerCase();
const NAME = arg("name") || "";
const CLONE_FROM = arg("clone-from");
const PASSWORD = arg("password") || "SketchDemo2026";
const YES = hasFlag("yes");

const DAY = 86400000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function fail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

if (!URL || !SERVICE_KEY) fail("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (env or .env.local).");
if (!ALLOW) fail("ALLOW_SEED=true is required. This script wipes and rebuilds a tenant.");
if (!SLUG) fail("--slug is required (e.g. --slug demo).");
if (!/^[a-z0-9][a-z0-9-]*$/.test(SLUG)) fail(`--slug must match ^[a-z0-9][a-z0-9-]*$ (got "${SLUG}").`);
if (!NAME) fail('--name is required (e.g. --name "Demo School").');

const db: SupabaseClient = createClient(URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Small helpers ─────────────────────────────────────────────────────────────

async function must<T>(
  p: PromiseLike<{ data: T; error: { message: string } | null }>,
  what: string,
): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) fail(`${what}: ${error.message}`);
  if (data == null) fail(`${what}: no data returned`);
  return data as NonNullable<T>;
}

/** All auth users, paged (the project is small; fine to sweep). */
async function listAllUsers(): Promise<{ id: string; email: string }[]> {
  const out: { id: string; email: string }[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`listUsers: ${error.message}`);
    for (const u of data.users) out.push({ id: u.id, email: (u.email || "").toLowerCase() });
    if (data.users.length < 200) break;
  }
  return out;
}

/** Recursively collect every object path under a prefix (storage list is per-folder). */
async function listObjects(bucket: string, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (folder: string) => {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await db.storage.from(bucket).list(folder, { limit: 100, offset });
      if (error || !data?.length) return;
      for (const entry of data) {
        const full = folder ? `${folder}/${entry.name}` : entry.name;
        // Folders come back with id null; files have an id.
        if (entry.id) paths.push(full);
        else await walk(full);
      }
      if (data.length < 100) return;
    }
  };
  await walk(prefix);
  return paths;
}

async function removeObjects(bucket: string, paths: string[]) {
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error } = await db.storage.from(bucket).remove(chunk);
    if (error) console.warn(`  ! storage ${bucket}: could not remove ${chunk.length} objects: ${error.message}`);
  }
}

async function copyObject(bucket: string, from: string, to: string): Promise<boolean> {
  const { error } = await db.storage.from(bucket).copy(from, to);
  if (error) {
    console.warn(`  ! storage ${bucket}: copy ${from} -> ${to} failed: ${error.message}`);
    return false;
  }
  return true;
}

/** Auth user + filled profile. handle_new_user() pre-creates the row → UPDATE. */
async function createAccount(opts: {
  email: string;
  fullName: string;
  role: "school_admin" | "teacher" | "student" | "parent";
  schoolId: string | null;
  username?: string;
  parentEmail?: string | null;
  maxBooks?: number;
}): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: opts.email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: opts.fullName, role: opts.role },
  });
  if (error || !data?.user) fail(`createUser ${opts.email}: ${error?.message ?? "no user"}`);
  const patch: Record<string, unknown> = {
    role: opts.role,
    full_name: opts.fullName,
    school_id: opts.schoolId,
    // Demo-tenant convenience: stable documented password, no forced reset.
    must_reset_password: false,
    // Provisioned with a known identity → skip the new-joiner onboarding gate.
    onboarded_at: new Date().toISOString(),
  };
  if (opts.username) patch.username = opts.username;
  if (opts.parentEmail !== undefined) patch.parent_email = opts.parentEmail;
  if (opts.maxBooks !== undefined) patch.max_books = opts.maxBooks;
  const { error: pErr } = await db.from("profiles").update(patch).eq("id", data.user.id);
  if (pErr) fail(`profile ${opts.email}: ${pErr.message}`);
  return data.user.id;
}

/** Find a globally-free student username (usernames are unique across tenants). */
async function freeUsername(first: string, last: string): Promise<string> {
  const base = usernameBase(first, last);
  let candidate = base;
  for (let n = 2; n < 1000; n++) {
    const { data } = await db.from("profiles").select("id").eq("username", candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base}${n}`;
  }
  fail(`could not find a free username for ${first} ${last}`);
}

/** The books/generations INSERT triggers enqueue real worker jobs — close them. */
async function closeJobs(filter: { generation_id?: string; book_id?: string }) {
  let q = db.from("jobs").update({ status: "done", progress: 100 });
  if (filter.generation_id) q = q.eq("generation_id", filter.generation_id);
  if (filter.book_id) q = q.eq("book_id", filter.book_id);
  const { error } = await q.eq("status", "queued");
  if (error) console.warn(`  ! could not close jobs (${JSON.stringify(filter)}): ${error.message}`);
}

// ── Roster (varied, realistic — demos must look real) ─────────────────────────

const TEACHERS = [
  { fullName: "Nurul Hassan", subject: "Science" },
  { fullName: "Daniel Lim", subject: "Mathematics" },
  { fullName: "Priya Nair", subject: "English" },
  { fullName: "Ahmad Faizal", subject: "History" },
  { fullName: "Mei Ling Tan", subject: "Geography" },
];
// Class name = "{subject} {grade} {suffix}", where subject comes from the book
// actually cloned to that teacher (so nobody "teaches Maths in Science 5A");
// falls back to the teacher's nominal subject when the library is empty.
const CLASSES = [
  { suffix: "Amanah", grade: "5" },
  { suffix: "Bestari", grade: "5" },
  { suffix: "Cerdik", grade: "4" },
  { suffix: "Dinamik", grade: "6" },
  { suffix: "Ehsan", grade: "5" },
];
const STUDENTS: [string, string][][] = [
  [["Aisha", "Rahman"], ["Wei Jian", "Tan"], ["Harvind", "Raj"], ["Nur Iman", "Zulkifli"], ["Sofea", "Aziz"]],
  [["Adam", "Mikhail"], ["Li Ying", "Wong"], ["Kavya", "Pillai"], ["Danish", "Haikal"], ["Chloe", "Lim"]],
  [["Arjun", "Menon"], ["Siti", "Khadijah"], ["Ethan", "Teo"], ["Alya", "Batrisyia"], ["Ravi", "Shankar"]],
  [["Hana", "Safiyya"], ["Jayden", "Koh"], ["Devi", "Lakshmi"], ["Iqbal", "Hakim"], ["Zara", "Amani"]],
  [["Amir", "Luqman"], ["Xin Yi", "Lee"], ["Tharun", "Kumar"], ["Balqis", "Huda"], ["Isaac", "Ng"]],
];

// A minimal one-page PDF (valid enough for viewers) for file-mode submissions.
const TINY_PDF = Buffer.from(
  `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 58>>stream
BT /F1 18 Tf 72 720 Td (SketchCast demo submission) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF`,
  "utf8",
);

// ── Wipe ──────────────────────────────────────────────────────────────────────

async function wipeTenant(): Promise<void> {
  const { data: school, error } = await db.from("schools").select("id, slug, name").eq("slug", SLUG).maybeSingle();
  if (error) {
    if (/slug|column/i.test(error.message))
      fail(`schools.slug missing — run migration 0042_school_tenant.sql in the Supabase SQL editor first (${error.message}).`);
    fail(`resolving school by slug: ${error.message}`);
  }
  const domain = `@${SLUG}.sketchcast.app`;
  const allUsers = await listAllUsers();
  const doomed = new Map<string, string>(); // id -> label

  if (school) {
    if (school.slug !== SLUG) fail(`paranoia check failed: resolved slug "${school.slug}" != "${SLUG}".`);
    // 1) Everyone whose profile is IN this school.
    const members = await must(
      db.from("profiles").select("id, role, full_name").eq("school_id", school.id),
      "listing tenant profiles",
    );
    for (const m of members ?? []) doomed.set(m.id, `${m.role} ${m.full_name ?? ""}`);
    // 2) Students enrolled in this school's classes (heals school_id-null orphans).
    const classes = await must(db.from("classes").select("id").eq("school_id", school.id), "listing tenant classes");
    const classIds = (classes ?? []).map((c: { id: string }) => c.id);
    if (classIds.length) {
      const enr = await must(
        db.from("enrollments").select("student_id").in("class_id", classIds),
        "listing tenant enrollments",
      );
      for (const e of enr ?? []) if (!doomed.has(e.student_id)) doomed.set(e.student_id, "student (via enrollment)");
    }
  }
  // 3) Seeder-created adults (incl. the parent, who never has school_id).
  for (const u of allUsers) if (u.email.endsWith(domain)) if (!doomed.has(u.id)) doomed.set(u.id, `adult ${u.email}`);

  if (!school && doomed.size === 0) {
    console.log(`No existing "${SLUG}" tenant — nothing to wipe.\n`);
    return;
  }

  console.log(`Wiping tenant "${SLUG}"${school ? ` (school ${school.id}, "${school.name}")` : ""}: ${doomed.size} accounts + their storage.`);

  // Storage first (objects don't cascade), then auth users (rows DO cascade:
  // profiles → books/generations/artifacts/classes/enrollments/progress/
  // submissions/coordinator_scope/parent_links/shares/jobs), then the school row.
  for (const uid of doomed.keys()) {
    for (const bucket of ["uploads", "artifacts", "submissions"]) {
      const paths = await listObjects(bucket, uid);
      if (paths.length) {
        await removeObjects(bucket, paths);
        console.log(`  - ${bucket}: removed ${paths.length} objects under ${uid.slice(0, 8)}…`);
      }
    }
  }
  let deleted = 0;
  for (const [uid, label] of doomed) {
    const { error: dErr } = await db.auth.admin.deleteUser(uid);
    if (dErr) console.warn(`  ! deleteUser ${uid.slice(0, 8)}… (${label}): ${dErr.message}`);
    else deleted++;
  }
  console.log(`  - deleted ${deleted}/${doomed.size} auth users (rows cascaded).`);

  if (school) {
    const { error: sErr } = await db.from("schools").delete().eq("id", school.id).eq("slug", SLUG);
    if (sErr) fail(`deleting schools row: ${sErr.message}`);
    console.log(`  - deleted schools row ${school.id}.\n`);
  }
}

// ── Clone library content ─────────────────────────────────────────────────────

type ClonedGen = { id: string; title: string; kind: string; teacherIdx: number };
type ClonedLibrary = { gensByTeacher: ClonedGen[][]; subjectByTeacher: (string | null)[] };

// Demo titles are prospect-facing: turn slug-like upload names
// ("pdfcoffee.com_cambridge-primary-science-year-7-lb-2nd-edition-pdf-free")
// into readable ones. No-op for titles that already contain spaces.
function cleanTitle(raw: string): string {
  let t = raw.replace(/^[a-z0-9.-]+\.(com|org|net|io)[_-]/i, "");
  if (/\s/.test(t)) return t; // already human-authored
  t = t.replace(/[-_]+/g, " ").replace(/\b(pdf|free|download)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  const EXPAND: Record<string, string> = { lb: "Learner's Book", wb: "Workbook", tb: "Teacher's Book" };
  return t
    .split(" ")
    .map((w) => EXPAND[w.toLowerCase()] ?? (/^[0-9]/.test(w) ? w : w[0]?.toUpperCase() + w.slice(1)))
    .join(" ");
}

async function cloneLibrary(schoolId: string, teacherIds: string[]): Promise<ClonedLibrary> {
  const perTeacher: ClonedGen[][] = teacherIds.map(() => []);
  const subjectByTeacher: (string | null)[] = teacherIds.map(() => null);
  if (!CLONE_FROM) {
    console.warn("! --clone-from not given: the library will be EMPTY (Watch/Deck/Worksheet/Quiz demo dead). Strongly consider --clone-from.");
    return { gensByTeacher: perTeacher, subjectByTeacher };
  }
  const src = (await listAllUsers()).find((u) => u.email === CLONE_FROM.toLowerCase());
  if (!src) fail(`--clone-from ${CLONE_FROM}: no such auth user.`);

  const books = await must(
    db
      .from("books")
      .select("id, title, author, kind, storage_path, pages, chapters, grade, subject, cover_path, health")
      .eq("owner_id", src.id)
      .eq("status", "ready")
      .is("removed_at", null)
      .order("created_at", { ascending: true }),
    "listing source books",
  );
  if (!books?.length) fail(`--clone-from ${CLONE_FROM}: no ready books to clone.`);
  console.log(
    `Cloning from ${CLONE_FROM} (${books.length} ready book(s), cycled across ${teacherIds.length} teachers so every class has openable lessons).`,
  );

  // EVERY teacher gets a book copy (cycle when the source has fewer books than
  // teachers) — an empty class is a dead demo screen.
  for (let tIdx = 0; tIdx < teacherIds.length; tIdx++) {
    const book = books[tIdx % books.length];
    const teacherId = teacherIds[tIdx];
    subjectByTeacher[tIdx] = (book.subject as string | null) ?? null;

    // Book file (uploads bucket) — path must start with the new owner's uid.
    let newStoragePath: string | null = null;
    if (book.storage_path) {
      const base = String(book.storage_path).split("/").pop();
      const dest = `${teacherId}/${base}`;
      if (await copyObject("uploads", book.storage_path, dest)) newStoragePath = dest;
    }
    let newCoverPath: string | null = null;
    if (book.cover_path) {
      const base = String(book.cover_path).split("/").pop();
      const dest = `${teacherId}/covers/${base}`;
      if (await copyObject("artifacts", book.cover_path, dest)) newCoverPath = dest;
    }

    const newBook = await must(
      db
        .from("books")
        .insert({
          title: cleanTitle(book.title as string),
          author: book.author,
          kind: book.kind,
          owner_id: teacherId,
          school_id: schoolId, // ← the shared-library visibility (books_read RLS)
          storage_path: newStoragePath,
          pages: book.pages,
          chapters: book.chapters,
          grade: book.grade,
          subject: book.subject,
          cover_path: newCoverPath,
          status: "ready",
          health: book.health,
        })
        .select("id")
        .single(),
      `cloning book "${book.title}"`,
    );
    await closeJobs({ book_id: newBook.id }); // don't let the worker re-index

    // Chapter grounding (assistant/tutor + gen-time grounding).
    const grounding = await must(
      db.from("chapter_grounding").select("*").eq("book_id", book.id),
      "reading chapter_grounding",
    );
    for (const g of grounding ?? []) {
      const { error } = await db.from("chapter_grounding").insert({ ...g, book_id: newBook.id });
      if (error) console.warn(`  ! grounding ch${g.chapter_num}: ${error.message}`);
    }

    // Done generations + their artifact files.
    const gens = await must(
      db
        .from("generations")
        .select("id, kind, chapter_ref, title, params")
        .eq("book_id", book.id)
        .eq("status", "done")
        .is("removed_at", null)
        .order("created_at", { ascending: true }),
      "listing source generations",
    );
    for (const gen of gens ?? []) {
      const newGen = await must(
        db
          .from("generations")
          .insert({
            kind: gen.kind,
            book_id: newBook.id,
            chapter_ref: gen.chapter_ref,
            title: gen.title,
            owner_id: teacherId,
            school_id: schoolId,
            status: "done",
            params: gen.params,
          })
          .select("id")
          .single(),
        `cloning generation "${gen.title}"`,
      );
      await closeJobs({ generation_id: newGen.id }); // don't let the worker regenerate

      const arts = await must(
        db.from("artifacts").select("kind, storage_path").eq("generation_id", gen.id),
        "listing source artifacts",
      );
      for (const a of arts ?? []) {
        const base = String(a.storage_path).split("/").pop();
        const dest = `${teacherId}/${newGen.id}/${base}`;
        if (await copyObject("artifacts", a.storage_path, dest)) {
          const { error } = await db.from("artifacts").insert({ generation_id: newGen.id, kind: a.kind, storage_path: dest });
          if (error) console.warn(`  ! artifact row ${a.kind}: ${error.message}`);
        }
      }
      perTeacher[tIdx].push({ id: newGen.id, title: gen.title ?? "Lesson", kind: gen.kind, teacherIdx: tIdx });
    }
    console.log(
      `  + book "${cleanTitle(book.title as string)}" → ${TEACHERS[tIdx].fullName} (${(gens ?? []).length} lessons, grounding ×${(grounding ?? []).length})`,
    );
  }
  return { gensByTeacher: perTeacher, subjectByTeacher };
}

// ── Build ─────────────────────────────────────────────────────────────────────

async function main() {
  const projectRef = new globalThis.URL(URL!).hostname.split(".")[0];
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target Supabase project : ${projectRef}`);
  console.log(`Target URL              : ${URL}`);
  console.log(`Tenant slug             : ${SLUG}`);
  console.log(`Tenant name             : ${NAME}`);
  console.log(`Clone library from      : ${CLONE_FROM ?? "(none — library will be empty!)"}`);
  console.log("──────────────────────────────────────────────────────");
  console.log("This will WIPE the tenant above (and only it), then rebuild it.");
  if (!YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Type the slug ("${SLUG}") to confirm: `)).trim();
    rl.close();
    if (answer !== SLUG) fail("confirmation did not match — nothing was touched.");
  }

  // Probe 0042 before anything destructive.
  {
    const { error } = await db.from("schools").select("id, slug, config, status").limit(1);
    if (error) fail(`migration 0042 not applied? ${error.message}`);
  }

  await wipeTenant();

  // ── School ──────────────────────────────────────────────────────────────────
  const school = await must(
    db
      .from("schools")
      .insert({
        name: NAME,
        slug: SLUG,
        display_name: NAME,
        status: "active",
        // Per-tenant leadership suite — lights dashboard/school/** for THIS school
        // only (schoolAnalyticsEnabledFor), no global env flip needed.
        config: { school_analytics: true },
      })
      .select("id")
      .single(),
    "creating school",
  );
  const schoolId = school.id as string;
  console.log(`+ school "${NAME}" (${schoolId})`);

  // ── Principal (school_admin + coordinator grant) ────────────────────────────
  const principalEmail = `principal@${SLUG}.sketchcast.app`;
  const principalId = await createAccount({
    email: principalEmail,
    fullName: "Salmah Ibrahim",
    role: "school_admin",
    schoolId,
  });
  await must(
    db
      .from("coordinator_scope")
      .insert({ coordinator_id: principalId, school_id: schoolId, grade: "5", subject: null })
      .select("id"),
    "principal coordinator_scope",
  );
  console.log(`+ principal ${principalEmail} (admin view + Grade 5 coordinator grant)`);

  // ── Teachers ────────────────────────────────────────────────────────────────
  const teacherIds: string[] = [];
  for (let i = 0; i < TEACHERS.length; i++) {
    const email = `teacher${i + 1}@${SLUG}.sketchcast.app`;
    const id = await createAccount({
      email,
      fullName: TEACHERS[i].fullName,
      role: "teacher",
      schoolId,
      maxBooks: 20, // lift the 1-book launch-trial cap (0024) for the demo library
    });
    teacherIds.push(id);
  }
  // teacher1 also coordinates Grade 5 → HER login shows the NAMED at-risk
  // worklist (admins see the aggregate view; the named list is the grant-holder's).
  await must(
    db
      .from("coordinator_scope")
      .insert({ coordinator_id: teacherIds[0], school_id: schoolId, grade: "5", subject: null })
      .select("id"),
    "teacher1 coordinator_scope",
  );
  console.log(`+ 5 teachers (teacher1 also holds the Grade 5 coordinator grant)`);

  // ── Library first (cloned real content) — class names derive from it ───────
  const { gensByTeacher, subjectByTeacher } = await cloneLibrary(schoolId, teacherIds);

  // ── Classes ─────────────────────────────────────────────────────────────────
  const classNames = CLASSES.map(
    (c, i) => `${subjectByTeacher[i] ?? TEACHERS[i].subject} ${c.grade} ${c.suffix}`,
  );
  const classIds: string[] = [];
  const joinCodes: string[] = [];
  for (let i = 0; i < CLASSES.length; i++) {
    const cls = await must(
      db
        .from("classes")
        .insert({ name: classNames[i], grade: CLASSES[i].grade, teacher_id: teacherIds[i], school_id: schoolId })
        .select("id, join_code")
        .single(),
      `creating class ${classNames[i]}`,
    );
    classIds.push(cls.id);
    joinCodes.push(cls.join_code);
  }
  console.log(`+ 5 classes`);

  // ── Students ────────────────────────────────────────────────────────────────
  const parentEmail = `parent@${SLUG}.sketchcast.app`;
  const studentIds: string[][] = [];
  const studentCreds: { class: string; name: string; username: string }[] = [];
  for (let c = 0; c < STUDENTS.length; c++) {
    const ids: string[] = [];
    for (const [first, last] of STUDENTS[c]) {
      const username = await freeUsername(first, last);
      const id = await createAccount({
        email: studentEmail(username),
        fullName: `${first} ${last}`,
        role: "student",
        schoolId,
        username,
        // Realistic roster + a contact for the at-risk worklist. Clearly-fake
        // domain so no real inbox can ever be hit from a demo.
        parentEmail: `${username}.parent@demo-families.example`,
      });
      const { error } = await db.from("enrollments").insert({ class_id: classIds[c], student_id: id });
      if (error) fail(`enrolling ${username}: ${error.message}`);
      ids.push(id);
      studentCreds.push({ class: classNames[c], name: `${first} ${last}`, username });
    }
    studentIds.push(ids);
  }
  console.log(`+ 25 students enrolled`);

  // ── Parent (linked to Aisha Rahman, class 1) ────────────────────────────────
  const parentId = await createAccount({
    email: parentEmail,
    fullName: "Rahman bin Yusof",
    role: "parent",
    schoolId: null, // parents never carry school_id
  });
  await must(
    db
      .from("parent_links")
      .insert({
        parent_id: parentId,
        child_id: studentIds[0][0],
        source: "school",
        created_by: principalId,
        verified_at: new Date().toISOString(),
      })
      .select("id"),
    "parent link",
  );
  await db.from("profiles").update({ parent_email: parentEmail }).eq("id", studentIds[0][0]);
  console.log(`+ parent ${parentEmail} → linked to ${STUDENTS[0][0].join(" ")}`);

  // ── Assignments + progress + submissions ────────────────────────────────────
  // Due-date mix: the first classes holding ≥2 lessons get TWO past-due shares
  // (so shaped students trip the "≥2 overdue" rule); the rest get one past +
  // upcoming dues.
  let shareCount = 0;
  let progressCount = 0;
  let submissionCount = 0;

  for (let c = 0; c < classIds.length; c++) {
    const gens = gensByTeacher[c] ?? [];
    if (gens.length === 0) {
      console.warn(`  ! class "${classNames[c]}": teacher has no cloned lessons — screens for this class will be thin.`);
      continue;
    }
    if (gens.length < 2)
      console.warn(`  ! class "${classNames[c]}": only 1 lesson — completion/overdue rules need ≥2 assigned to fully light up.`);
    const share = gens.slice(0, 3);
    const heavyOverdue = c <= 2 && share.length >= 2; // the shaped ≥2-overdue classes
    const dues = heavyOverdue
      ? [iso(6 * DAY), iso(2 * DAY), new Date(now + 7 * DAY).toISOString()]
      : [iso(4 * DAY), new Date(now + 6 * DAY).toISOString(), new Date(now + 12 * DAY).toISOString()];
    for (let s = 0; s < share.length; s++) {
      await must(
        db
          .from("generation_shares")
          .insert({
            generation_id: share[s].id,
            class_id: classIds[c],
            shared_by: teacherIds[c],
            due_at: dues[s],
          })
          .select("id"),
        `share ${share[s].title} → ${classNames[c]}`,
      );
      shareCount++;
    }

    const [s0, s1, s2, s3] = studentIds[c]; // s4 = never started (no rows at all)
    const teacher = teacherIds[c];
    const progress: Record<string, unknown>[] = [];
    const subs: Record<string, unknown>[] = [];

    // s0 — the star: everything completed, quick auto-scored quizzes.
    for (let s = 0; s < share.length; s++) {
      progress.push({
        generation_id: share[s].id,
        student_id: s0,
        class_id: classIds[c],
        status: "completed",
        progress_pct: 100,
        opened_at: iso((8 - s) * DAY),
        completed_at: iso((3 - Math.min(s, 2)) * DAY),
        updated_at: iso((3 - Math.min(s, 2)) * DAY),
      });
      subs.push({
        generation_id: share[s].id,
        student_id: s0,
        mode: "interactive",
        answers: { q1: "B", q2: "Photosynthesis uses sunlight to make food", q3: "True" },
        auto_score: 9 - s,
        max_score: 10,
        grade_status: s === share.length - 1 ? "pending" : "auto", // one lands in "To grade"
        submitted_at: iso((3 - Math.min(s, 2)) * DAY),
      });
    }
    // s1 — the reviser: revised share0 (hotspot), completed share1 (teacher-graded).
    progress.push({
      generation_id: share[0].id,
      student_id: s1,
      class_id: classIds[c],
      status: "revised",
      progress_pct: 100,
      opened_at: iso(9 * DAY),
      completed_at: iso(5 * DAY),
      revised_at: iso(2 * DAY),
      revision_count: 3,
      updated_at: iso(2 * DAY),
    });
    if (share[1]) {
      progress.push({
        generation_id: share[1].id,
        student_id: s1,
        class_id: classIds[c],
        status: "completed",
        progress_pct: 100,
        opened_at: iso(6 * DAY),
        completed_at: iso(4 * DAY),
        updated_at: iso(4 * DAY),
      });
      subs.push({
        generation_id: share[1].id,
        student_id: s1,
        mode: "interactive",
        answers: { q1: "C", q2: "The water cycle: evaporation, condensation, rain", q3: "False" },
        auto_score: 7,
        max_score: 10,
        teacher_score: 8,
        feedback: "Good reasoning on Q2 — half a mark back for the diagram.",
        grade_status: "graded",
        graded_by: teacher,
        graded_at: iso(1 * DAY),
        submitted_at: iso(4 * DAY),
      });
    }
    // s2 — mid-flight: in progress now; in class 0, DECLINING scores.
    progress.push({
      generation_id: share[0].id,
      student_id: s2,
      class_id: classIds[c],
      status: "in_progress",
      progress_pct: 45,
      opened_at: iso(2 * DAY),
      updated_at: iso(1 * DAY),
    });
    if (c === 0 && share[1]) {
      progress.push({
        generation_id: share[1].id,
        student_id: s2,
        class_id: classIds[c],
        status: "completed",
        progress_pct: 100,
        opened_at: iso(21 * DAY),
        completed_at: iso(20 * DAY),
        updated_at: iso(20 * DAY),
      });
      subs.push(
        {
          generation_id: share[1].id,
          student_id: s2,
          mode: "interactive",
          answers: { q1: "A", q2: "Correct detailed answer", q3: "True" },
          auto_score: 9,
          max_score: 10,
          grade_status: "auto",
          submitted_at: iso(20 * DAY),
        },
        {
          generation_id: share[0].id,
          student_id: s2,
          mode: "interactive",
          answers: { q1: "D", q2: "(left blank)", q3: "False" },
          auto_score: 3,
          max_score: 10,
          grade_status: "auto",
          submitted_at: iso(2 * DAY),
        },
      );
    }
    // s3 — AT-RISK: barely started weeks ago, inactive >14d, low scores, and in
    // the heavy-overdue classes both past-due shares are incomplete (≥2 overdue).
    progress.push({
      generation_id: share[0].id,
      student_id: s3,
      class_id: classIds[c],
      status: "in_progress",
      progress_pct: 10,
      opened_at: iso(25 * DAY),
      updated_at: iso(20 * DAY), // BEFORE UPDATE touch trigger → survives on INSERT
    });
    if (c === 2 && share[1]) {
      subs.push(
        {
          generation_id: share[0].id,
          student_id: s3,
          mode: "interactive",
          answers: { q1: "B", q2: "?", q3: "True" },
          auto_score: 3,
          max_score: 10,
          grade_status: "auto",
          submitted_at: iso(20 * DAY),
        },
        {
          generation_id: share[1].id,
          student_id: s3,
          mode: "interactive",
          answers: { q1: "A", q2: "-", q3: "False" },
          auto_score: 2,
          max_score: 10,
          grade_status: "auto",
          submitted_at: iso(18 * DAY),
        },
      );
    }
    // A pending FILE submission for classes 2-4 (real uploaded PDF → openable).
    if (c >= 2 && share[0]) {
      const path = `${s1}/${share[0].id}/worksheet-answers.pdf`;
      const { error: upErr } = await db.storage
        .from("submissions")
        .upload(path, TINY_PDF, { contentType: "application/pdf", upsert: true });
      if (upErr) console.warn(`  ! submissions upload: ${upErr.message}`);
      else
        subs.push({
          generation_id: share[0].id,
          student_id: s1,
          mode: "file",
          file_path: path,
          grade_status: "pending",
          submitted_at: iso(1 * DAY),
        });
    }

    for (const p of progress) {
      const { error } = await db.from("student_progress").insert(p);
      if (error) console.warn(`  ! progress: ${error.message}`);
      else progressCount++;
    }
    for (const s of subs) {
      const { error } = await db.from("submissions").insert(s);
      if (error) console.warn(`  ! submission: ${error.message}`);
      else submissionCount++;
    }
  }
  console.log(`+ ${shareCount} assignments, ${progressCount} progress rows, ${submissionCount} submissions`);

  // ── Credentials file ────────────────────────────────────────────────────────
  const portal = `https://school.sketchcast.app/${SLUG}`;
  const outDir = "scripts/out";
  mkdirSync(outDir, { recursive: true });
  const credentials = {
    school: { name: NAME, slug: SLUG, id: schoolId, portal },
    password: PASSWORD,
    principal: { name: "Salmah Ibrahim", email: principalEmail, notes: "Admin aggregate view + Grade 5 coordinator grant" },
    teachers: TEACHERS.map((t, i) => ({
      name: t.fullName,
      email: `teacher${i + 1}@${SLUG}.sketchcast.app`,
      class: classNames[i],
      joinCode: joinCodes[i],
      notes: i === 0 ? "Also Grade 5 coordinator → sees the NAMED at-risk worklist" : undefined,
    })),
    parent: { name: "Rahman bin Yusof", email: parentEmail, child: STUDENTS[0][0].join(" ") },
    students: studentCreds,
  };
  writeFileSync(`${outDir}/${SLUG}-credentials.json`, JSON.stringify(credentials, null, 2));

  const md: string[] = [];
  md.push(`# ${NAME} — demo credentials`, "");
  md.push(`Portal: ${portal}  ·  Shared password for **every** account: \`${PASSWORD}\``, "");
  md.push(`## Principal — ${portal}/principal`, "", "| Name | Email | Shows |", "|---|---|---|");
  md.push(`| Salmah Ibrahim | \`${principalEmail}\` | Whole-school aggregate + Access/Admin (also holds a Grade 5 coordinator grant) |`, "");
  md.push(`## Teachers — ${portal}/teacher`, "", "| # | Name | Email | Class | Join code |", "|---|---|---|---|---|");
  TEACHERS.forEach((t, i) =>
    md.push(
      `| ${i + 1} | ${t.fullName}${i === 0 ? " (coordinator)" : ""} | \`teacher${i + 1}@${SLUG}.sketchcast.app\` | ${classNames[i]} | \`${joinCodes[i]}\` |`,
    ),
  );
  md.push("", `Teacher 1 also holds the Grade 5 coordinator grant — her School tab shows the **named at-risk worklist**.`, "");
  md.push(`## Parent — ${portal}/parent`, "", `| Rahman bin Yusof | \`${parentEmail}\` | child: ${STUDENTS[0][0].join(" ")} |`, "");
  md.push(`## Students — ${portal}/student (log in with the student ID)`, "", "| Class | Name | Student ID |", "|---|---|---|");
  for (const s of studentCreds) md.push(`| ${s.class} | ${s.name} | \`${s.username}\` |`);
  md.push("", `_Seeded ${new Date().toISOString()} against project \`${projectRef}\`. Re-running the seeder resets everything above to this exact state._`);
  writeFileSync(`${outDir}/${SLUG}-credentials.md`, md.join("\n"));
  console.log(`+ credentials → ${outDir}/${SLUG}-credentials.md (+ .json)`);

  // ── Verification report ─────────────────────────────────────────────────────
  console.log("\n── Verification ──────────────────────────────────────");
  const count = async (table: string, filter: (q: any) => any): Promise<number> => {
    const { count: n } = await filter(db.from(table).select("*", { count: "exact", head: true }));
    return n ?? 0;
  };
  const tenantGenIds = (await must(db.from("generations").select("id").eq("school_id", schoolId), "gen ids")).map(
    (g: { id: string }) => g.id,
  );
  const tenantBookIds = (await must(db.from("books").select("id").eq("school_id", schoolId), "book ids")).map(
    (b: { id: string }) => b.id,
  );
  // Jobs the INSERT triggers enqueued: generation jobs carry generation_id,
  // index_book jobs carry book_id — the seeder must have closed BOTH kinds.
  const openJobs =
    (tenantGenIds.length ? await count("jobs", (q) => q.eq("status", "queued").in("generation_id", tenantGenIds)) : 0) +
    (tenantBookIds.length ? await count("jobs", (q) => q.eq("status", "queued").in("book_id", tenantBookIds)) : 0);
  const rows: [string, number][] = [
    ["profiles (school members)", await count("profiles", (q) => q.eq("school_id", schoolId))],
    ["classes", await count("classes", (q) => q.eq("school_id", schoolId))],
    ["enrollments", await count("enrollments", (q) => q.in("class_id", classIds))],
    ["coordinator_scope", await count("coordinator_scope", (q) => q.eq("school_id", schoolId))],
    ["books", tenantBookIds.length],
    ["generations", tenantGenIds.length],
    ["artifacts", tenantGenIds.length ? await count("artifacts", (q) => q.in("generation_id", tenantGenIds)) : 0],
    ["generation_shares", tenantGenIds.length ? await count("generation_shares", (q) => q.in("generation_id", tenantGenIds)) : 0],
    ["student_progress", tenantGenIds.length ? await count("student_progress", (q) => q.in("generation_id", tenantGenIds)) : 0],
    ["submissions", tenantGenIds.length ? await count("submissions", (q) => q.in("generation_id", tenantGenIds)) : 0],
    ["parent_links (demo parent)", await count("parent_links", (q) => q.eq("parent_id", parentId))],
    ["open jobs (must be 0)", openJobs],
  ];
  for (const [label, n] of rows) console.log(`  ${label.padEnd(28)} ${n}`);

  // Cross-tenant isolation: sign in AS a demo student (anon key + RLS) and
  // verify every visible row belongs to this school.
  if (ANON_KEY) {
    const anon = createClient(URL!, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: siErr } = await anon.auth.signInWithPassword({
      email: studentEmail(studentCreds[0].username),
      password: PASSWORD,
    });
    if (siErr) console.warn(`  ! isolation check: could not sign in as ${studentCreds[0].username}: ${siErr.message}`);
    else {
      const { data: visBooks } = await anon.from("books").select("id, school_id");
      const { data: visSchools } = await anon.from("schools").select("id");
      const { data: visClasses } = await anon.from("classes").select("id, school_id");
      const leaks =
        (visBooks ?? []).filter((b) => b.school_id !== schoolId).length +
        (visSchools ?? []).filter((s) => s.id !== schoolId).length +
        (visClasses ?? []).filter((cl) => cl.school_id !== schoolId).length;
      console.log(
        leaks === 0
          ? `  isolation check              PASS (student sees only "${SLUG}" rows: ${visBooks?.length ?? 0} books, ${visClasses?.length ?? 0} classes, ${visSchools?.length ?? 0} school)`
          : `  isolation check              FAIL — ${leaks} row(s) from another tenant are visible!`,
      );
      await anon.auth.signOut();
    }
  } else console.warn("  ! isolation check skipped: NEXT_PUBLIC_SUPABASE_ANON_KEY not set.");

  console.log("──────────────────────────────────────────────────────");
  console.log(`\n✓ Tenant "${SLUG}" ready.`);
  console.log(`  ${portal}            (landing)`);
  console.log(`  ${portal}/principal  ·  ${portal}/teacher`);
  console.log(`  ${portal}/student    ·  ${portal}/parent`);
  console.log(`  Shared password: ${PASSWORD}\n`);
  if (!existsSync(`${outDir}/.gitignore`)) writeFileSync(`${outDir}/.gitignore`, "*\n!.gitignore\n");
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e?.message ?? e);
  process.exit(1);
});
