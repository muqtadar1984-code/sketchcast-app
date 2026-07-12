// Seed a self-contained DEMO world into the LOCAL Supabase stack so the whole portal
// can be exercised offline (front-end + auth + RLS), with zero prod risk.
//
// Reads LOCAL creds from .env.development.local (NEVER .env.local), and HARD-REFUSES any
// non-local URL — so this can never seed production. Idempotent: safe to re-run.
//
//   1) supabase start            (Docker; applies migrations 0001..0038 + storage buckets)
//   2) node supabase/seed_demo.mjs   (or: npm run db:seed)
//
// Demo password for every account (LOCAL ONLY): "sketchcast".
// Generation artifacts are ROW-ONLY (no real files) — the lesson appears in the UI but
// Watch/Deck won't play until you run the worker locally against this DB.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
    );
  } catch { return {}; }
}
const env = readEnv(".env.development.local");
const URL = process.env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Missing local creds. Create .env.development.local (see docs/qa/LOCAL-DEV.md) with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from `npx supabase status`.");
  process.exit(1);
}
// SAFETY: only ever seed a local stack.
if (!/(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(URL)) {
  console.error(`REFUSED: seed only runs against a LOCAL Supabase. Got: ${URL}`);
  process.exit(2);
}
const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const PW = "sketchcast";
const nowISO = new Date().toISOString();

async function findUser(email) {
  for (let page = 1; page <= 20; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
    const u = data.users.find((x) => (x.email || "").toLowerCase() === email.toLowerCase());
    if (u) return u;
    if (data.users.length < 200) break;
  }
  return null;
}
async function upsertUser(email, role, fullName) {
  let u = await findUser(email);
  if (!u) {
    const { data, error } = await db.auth.admin.createUser({
      email, password: PW, email_confirm: true, user_metadata: { full_name: fullName, role },
    });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    u = data.user;
    console.log(`  + auth user ${email}`);
  } else {
    console.log(`  = auth user ${email} (exists)`);
  }
  return u.id;
}

async function main() {
  console.log(`Seeding LOCAL demo world → ${URL}\n`);

  // ── School ────────────────────────────────────────────────────────────────
  let { data: school } = await db.from("schools").select("id").eq("name", "Demo Primary School").maybeSingle();
  if (!school) {
    school = (await db.from("schools").insert({ name: "Demo Primary School" }).select("id").single()).data;
    console.log("  + school Demo Primary School");
  }
  const schoolId = school.id;

  // ── Users (auth + profile) ─────────────────────────────────────────────────
  const principal = await upsertUser("demo.principal@sketchcast.app", "school_admin", "Demo Principal");
  const teacher1 = await upsertUser("demo.teacher1@sketchcast.app", "teacher", "Demo Teacher 1");
  const teacher2 = await upsertUser("demo.teacher2@sketchcast.app", "teacher", "Demo Teacher 2");
  const parent1 = await upsertUser("demo.parent1@sketchcast.app", "parent", "Demo Parent 1");
  const s1 = await upsertUser("demo.s1@students.sketchcast.app", "student", "Demo Student 1");
  const s2 = await upsertUser("demo.s2@students.sketchcast.app", "student", "Demo Student 2");

  // Profiles (role/school_id are service-role-only; the trigger made the base row).
  const setProfile = (id, patch) => db.from("profiles").update({ onboarded_at: nowISO, ...patch }).eq("id", id);
  await setProfile(principal, { role: "school_admin", full_name: "Demo Principal", school_id: schoolId });
  await setProfile(teacher1, { role: "teacher", full_name: "Demo Teacher 1", school_id: schoolId });
  await setProfile(teacher2, { role: "teacher", full_name: "Demo Teacher 2", school_id: schoolId });
  await setProfile(parent1, { role: "parent", full_name: "Demo Parent 1" }); // parents never get school_id
  await setProfile(s1, { role: "student", full_name: "Demo Student 1", username: "demo.s1", parent_email: "demo.parent1@sketchcast.app", school_id: schoolId });
  await setProfile(s2, { role: "student", full_name: "Demo Student 2", username: "demo.s2", parent_email: "demo.parent1@sketchcast.app", school_id: schoolId });
  console.log("  = profiles set (all onboarded)");

  // ── Class + enrollments ─────────────────────────────────────────────────────
  let { data: cls } = await db.from("classes").select("id").eq("name", "Demo Class 5A").eq("teacher_id", teacher1).maybeSingle();
  if (!cls) {
    cls = (await db.from("classes").insert({ name: "Demo Class 5A", grade: "5", teacher_id: teacher1, school_id: schoolId }).select("id").single()).data;
    console.log("  + class Demo Class 5A");
  }
  for (const sid of [s1, s2]) {
    const { data: e } = await db.from("enrollments").select("id").eq("class_id", cls.id).eq("student_id", sid).maybeSingle();
    if (!e) await db.from("enrollments").insert({ class_id: cls.id, student_id: sid });
  }
  // Parent links → both students
  for (const cid of [s1, s2]) {
    await db.from("parent_links").upsert(
      { parent_id: parent1, child_id: cid, source: "manual", verified_at: nowISO },
      { onConflict: "parent_id,child_id" },
    );
  }
  console.log("  = enrollments + parent_links");

  // ── Book (ready) + grounding for the assistant ──────────────────────────────
  let { data: book } = await db.from("books").select("id").eq("title", "Grade 5 Science (demo)").eq("owner_id", teacher1).maybeSingle();
  if (!book) {
    book = (await db.from("books").insert({
      title: "Grade 5 Science (demo)", author: "SketchCast Demo", kind: "textbook", owner_id: teacher1, school_id: schoolId,
      status: "ready", grade: "5", subject: "Science",
      chapters: [{ num: 1, title: "Unit 1: Be a designer" }, { num: 2, title: "Unit 2: Living things" }],
    }).select("id").single()).data;
    console.log("  + book Grade 5 Science (demo)");
  }
  await db.from("chapter_grounding").upsert({
    book_id: book.id, chapter_num: 1, chapter_title: "Unit 1: Be a designer",
    script_text: "Designers solve problems for people. Good designers think first and sketch ideas before building. They ask what the user needs, test their idea, and improve it. Being creative means exploring many solutions to the same problem. In computing, designers create apps, websites and games that people use every day.",
    source_text: "Unit 1: Be a designer — design thinking, the user, prototype and test, iteration, creativity.",
  }, { onConflict: "book_id,chapter_num" });
  console.log("  = chapter_grounding (ch.1)");

  // ── A 'done' presentation generation (row-only artifacts) ────────────────────
  let { data: gen } = await db.from("generations").select("id").eq("title", "Unit 1: Be a designer").eq("owner_id", teacher1).maybeSingle();
  if (!gen) {
    gen = (await db.from("generations").insert({
      kind: "presentation", book_id: book.id, chapter_ref: "1", title: "Unit 1: Be a designer",
      owner_id: teacher1, school_id: schoolId, status: "done",
    }).select("id").single()).data;
    console.log("  + generation (presentation, done)");
    // placeholder artifacts (no real files — Watch/Deck need the worker to be real)
    await db.from("artifacts").insert([
      { generation_id: gen.id, kind: "video_mp4", storage_path: `demo/${gen.id}/video.mp4` },
      { generation_id: gen.id, kind: "deck_pptx", storage_path: `demo/${gen.id}/deck.pptx` },
    ]);
  }
  // Share to the class + student progress
  await db.from("generation_shares").upsert(
    { generation_id: gen.id, class_id: cls.id, shared_by: teacher1 },
    { onConflict: "generation_id,class_id" },
  );
  for (const [sid, status, pct] of [[s1, "completed", 100], [s2, "in_progress", 20]]) {
    const { data: p } = await db.from("student_progress").select("id").eq("generation_id", gen.id).eq("student_id", sid).maybeSingle();
    if (!p) await db.from("student_progress").insert({ generation_id: gen.id, student_id: sid, class_id: cls.id, status, progress_pct: pct });
  }
  console.log("  = share + student_progress\n");

  console.log("✓ Demo world ready. Log in at http://localhost:3000 with any of:");
  console.log("    demo.principal@sketchcast.app | demo.teacher1@sketchcast.app | demo.parent1@sketchcast.app");
  console.log("    students: demo.s1 / demo.s2 (login accepts the bare ID)");
  console.log(`    password (all): ${PW}`);
  console.log("  To test the onboarding gate: null a demo adult's onboarded_at, then load /dashboard.");
}
main().catch((e) => { console.error("\nSEED FAILED:", e.message); process.exit(1); });
