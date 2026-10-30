// SK S6 slice C — the "SK & privacy" settings: the page's data and the three
// routes' cores (S6 design decisions 2, 5, 7; Final Plan §9.5). Server only.
//
//   loadSkSettings      the page's data, by role (pure describe* helpers turn
//                       facts into plain-language rows; the page localises them)
//   savePrefs           POST /api/sk/prefs        — the SK preferences as
//                       workflow facts, the user's OWN session (RLS owner-only)
//   consentRequest      POST /api/sk/consent      — a VERIFIED linked parent
//                       grants / revokes `transcripts` or `voice` for a child,
//                       through the 0173 RPC on the parent's own session
//                       (consent.ts setConsent); an unlinked child is refused
//                       here first, and the database checks again
//   schoolMemoryRequest POST /api/sk/school-memory — a PRINCIPAL (role
//                       school_admin) switches schools.config.sk_learning_memory
//                       for their OWN school, mirroring the timetable settings
//                       route: role + school from the caller's own profile, the
//                       config merged and written with the service role. Who
//                       and when are stored beside it.
//
// Nothing here sends anything to anyone.

import { consentSource, setConsent, type ConsentDb, type RpcDb } from "./consent";
import { recallLearning, recallWorkflow, rememberWorkflow, type FactsDb, type LearningFact, type WorkflowFact } from "./facts";
import { isVerifiedChildOf, type MemoryDb } from "./memory-delete";
import { PREF_FACT_KEY, PREF_KEYS, PREF_KIND, pick, prefsFromFacts, withDefaults, type SkPrefKey, type SkPrefs, type StoredPrefs } from "./prefs";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SettingsDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
type Reply = { status: number; body: Record<string, unknown> };

function rowsOf(r: unknown, what: string): Row[] {
  const x = r as { data?: unknown; error?: { message?: string } | null } | null;
  if (x?.error) throw new Error(`[sk settings] ${what}: ${x.error.message ?? "error"}`);
  return Array.isArray(x?.data) ? (x!.data as Row[]) : x?.data ? [x.data as Row] : [];
}
const str = (v: unknown, max = 160) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const displayName = (p: Row | undefined) => str(p?.full_name) || str(p?.username) || "";

// ── plain-language rows ─────────────────────────────────────────────────────

export type WorkflowRow =
  | { kind: "recent_class" | "recent_kit" | "pending_task" | "other"; label: string; date: string | null }
  | { kind: "preference"; pref: SkPrefKey; on: boolean; date: string | null };
export type LearningRow = { kind: LearningFact["kind"]; label: string; date: string | null; until: string | null };

const KEY_TO_PREF = new Map<string, SkPrefKey>(PREF_KEYS.map((k) => [PREF_FACT_KEY[k], k]));

/** PURE: what each workflow fact means, in words the page can show. */
export function describeWorkflow(facts: readonly WorkflowFact[]): WorkflowRow[] {
  const out: WorkflowRow[] = [];
  for (const f of facts) {
    const v = (f.value ?? {}) as Record<string, unknown>;
    if (f.kind === PREF_KIND) {
      const pref = KEY_TO_PREF.get(f.key);
      if (pref && typeof v.on === "boolean") out.push({ kind: "preference", pref, on: v.on, date: f.updatedAt });
      continue;
    }
    if (f.kind === "recent_class") out.push({ kind: "recent_class", label: str(v.label) || f.key, date: f.updatedAt });
    else if (f.kind === "recent_kit") {
      const label = str(v.label);
      const cls = str(v.classLabel, 60);
      out.push({ kind: "recent_kit", label: cls && label ? `${cls}, ${label}` : label || f.key, date: f.updatedAt });
    } else if (f.kind === "pending_task") out.push({ kind: "pending_task", label: str(v.task) || f.key, date: f.updatedAt });
    else out.push({ kind: "other", label: f.key, date: f.updatedAt });
  }
  return out;
}

/** PURE: a learning fact's words — the misconception SK named, else the idea it is about. */
export function describeLearning(facts: readonly LearningFact[]): LearningRow[] {
  return facts.map((f) => {
    const d = (f.detail ?? {}) as Record<string, unknown>;
    const label = str(d.misconception, 200) || str(d.heading, 200) || str(d.idea, 200) || str(d.label, 200) || str(f.objectiveKey, 200);
    return { kind: f.kind, label, date: f.createdAt, until: f.expiresAt };
  });
}

// ── the page's data ─────────────────────────────────────────────────────────

export type ChildConsentRow = { id: string; name: string; transcripts: boolean; voice: boolean };
export type SchoolSwitchRow = { id: string; name: string; on: boolean; changedBy: string | null; changedAt: string | null };
export type StudentMemoryRow = { memory: "parent" | "school" | null; voice: "parent" | "school" | null };

export type SkSettingsData = {
  role: string | null;
  prefs: SkPrefs;
  /** false when the fact stores cannot be read (0173 not applied yet). */
  memoryReadable: boolean;
  workflow: WorkflowRow[];
  /** A student's own learning facts; null for everyone else. */
  learning: LearningRow[] | null;
  /** The caller's VERIFIED children and the caller's own consent for each. */
  children: ChildConsentRow[];
  /** A principal's school switch; null for everyone else. */
  school: SchoolSwitchRow | null;
  /** A student's memory: on (and by whom) or off. */
  student: StudentMemoryRow | null;
};

export type LoadSettingsInput = {
  /** The caller's own session client (RLS). */
  session: SettingsDb;
  /** The service-role client, or null when there is none (sections degrade). */
  admin: SettingsDb | null;
  userId: string;
  role: string | null;
  schoolId: string | null;
  now?: Date;
};

const ALL_WORKFLOW_KINDS = ["preference", "recent_class", "recent_kit", "pending_task"];

/** The page's data. Every section degrades on its own; nothing throws. */
export async function loadSkSettings(input: LoadSettingsInput): Promise<SkSettingsData> {
  const { session, admin, userId, role, schoolId } = input;
  const now = input.now ?? new Date();
  const out: SkSettingsData = { role, prefs: withDefaults(null, role), memoryReadable: false, workflow: [], learning: null, children: [], school: null, student: null };

  try {
    const facts = await recallWorkflow(session as FactsDb, userId, ALL_WORKFLOW_KINDS, now);
    out.prefs = withDefaults(prefsFromFacts(facts), role);
    out.workflow = describeWorkflow(facts);
    out.memoryReadable = true;
  } catch (e) {
    console.warn("[sk settings] workflow facts unreadable:", (e as Error).message);
  }

  if (role === "student") {
    try {
      out.learning = describeLearning(await recallLearning(session as FactsDb, userId, now));
    } catch (e) {
      out.learning = [];
      console.warn("[sk settings] learning facts unreadable:", (e as Error).message);
    }
    if (admin) {
      const [memory, voice] = await Promise.all([consentSource(admin as ConsentDb, userId, "transcripts"), consentSource(admin as ConsentDb, userId, "voice")]);
      out.student = { memory, voice };
    } else out.student = { memory: null, voice: null };
    return out;
  }

  // Children: the caller's own links (RLS: pl_parent_read), VERIFIED only.
  try {
    const links = rowsOf(await session.from("parent_links").select("parent_id, child_id, verified_at").eq("parent_id", userId), "parent_links").filter(
      (l) => l.parent_id === userId && typeof l.child_id === "string" && typeof l.verified_at === "string" && !!l.verified_at,
    );
    const ids = [...new Set(links.map((l) => l.child_id as string))].filter((id) => UUID_RE.test(id));
    if (ids.length && admin) {
      const [profiles, consents] = await Promise.all([
        admin.from("profiles").select("id, full_name, username").in("id", ids),
        admin.from("consents").select("child_id, guardian_id, scope, revoked_at").eq("guardian_id", userId).in("child_id", ids),
      ]);
      const names = new Map(rowsOf(profiles, "child profiles").map((p) => [p.id as string, displayName(p)] as const));
      const live = rowsOf(consents, "consents").filter((c) => c.guardian_id === userId && !c.revoked_at);
      const on = (id: string, scope: string) => live.some((c) => c.child_id === id && c.scope === scope);
      out.children = ids.map((id) => ({ id, name: names.get(id) || "", transcripts: on(id, "transcripts"), voice: on(id, "voice") }));
    }
  } catch (e) {
    console.warn("[sk settings] children unreadable:", (e as Error).message);
  }

  if (role === "school_admin" && schoolId && admin) {
    try {
      const s = rowsOf(await admin.from("schools").select("id, name, display_name, config").eq("id", schoolId).maybeSingle(), "school")[0];
      if (s && s.id === schoolId) {
        const cfg = (s.config ?? {}) as { sk_learning_memory?: unknown; sk_learning_memory_changed?: { by?: unknown; at?: unknown } };
        const by = typeof cfg.sk_learning_memory_changed?.by === "string" ? cfg.sk_learning_memory_changed.by : null;
        let changedBy: string | null = null;
        if (by && UUID_RE.test(by)) {
          const p = rowsOf(await admin.from("profiles").select("id, full_name, username").eq("id", by).maybeSingle(), "changer")[0];
          changedBy = displayName(p) || null;
        }
        out.school = {
          id: schoolId,
          name: str(s.display_name) || str(s.name),
          on: cfg.sk_learning_memory === true,
          changedBy,
          changedAt: typeof cfg.sk_learning_memory_changed?.at === "string" ? cfg.sk_learning_memory_changed.at : null,
        };
      }
    } catch (e) {
      console.warn("[sk settings] school unreadable:", (e as Error).message);
    }
  }
  return out;
}

// ── POST /api/sk/prefs ──────────────────────────────────────────────────────

/** Store the given preferences (any subset) as the owner's workflow facts. */
export async function savePrefs(session: FactsDb, userId: string, body: unknown, now: Date = new Date()): Promise<Reply> {
  const patch: StoredPrefs = pick(body);
  const keys = Object.keys(patch) as SkPrefKey[];
  if (!keys.length) return { status: 400, body: { error: "Send readAloud, handsFree, suggestions, micOn or showText as true or false." } };
  const results = await Promise.all(keys.map((k) => rememberWorkflow(session, userId, PREF_KIND, PREF_FACT_KEY[k], { on: patch[k] }, now)));
  if (results.some((ok) => !ok)) return { status: 500, body: { error: "Your settings could not be saved. Please try again." } };
  return { status: 200, body: { ok: true, saved: patch } };
}

// ── POST /api/sk/consent ────────────────────────────────────────────────────

/** The scopes a parent switches on this page. `analytics` is not offered. */
export const PARENT_SCOPES = ["transcripts", "voice"] as const;

export async function consentRequest(input: { session: RpcDb & MemoryDb; userId: string; role: string | null; body: unknown }): Promise<Reply> {
  const b = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const child = typeof b.child === "string" ? b.child.toLowerCase() : "";
  const scope = typeof b.scope === "string" ? b.scope : "";
  if (!UUID_RE.test(child) || !(PARENT_SCOPES as readonly string[]).includes(scope) || typeof b.grant !== "boolean") {
    return { status: 400, body: { error: "Send child (an id), scope (transcripts or voice) and grant (true or false)." } };
  }
  // A student never grants consent, for herself or anyone (decision 2).
  if (input.role === "student" || child === input.userId) return { status: 403, body: { error: "Only a parent can change this." } };
  let linked = false;
  try {
    linked = await isVerifiedChildOf(input.session, input.userId, child);
  } catch (e) {
    console.error("[sk consent] link check failed:", (e as Error).message);
    return { status: 500, body: { error: "This could not be changed. Please try again." } };
  }
  if (!linked) return { status: 403, body: { error: "You can only change this for a child linked and verified on your account." } };
  const r = await setConsent(input.session, child, scope, b.grant);
  if (r.ok) return { status: 200, body: { ok: true, consent: r.consent } };
  if (r.reason === "not_parent") return { status: 403, body: { error: "You can only change this for a child linked and verified on your account." } };
  if (r.reason === "bad_input") return { status: 400, body: { error: "That change is not valid." } };
  return { status: 500, body: { error: "This could not be changed. Please try again." } };
}

// ── POST /api/sk/school-memory ──────────────────────────────────────────────

export async function schoolMemoryRequest(input: { session: SettingsDb; admin: () => SettingsDb; userId: string; body: unknown; now?: Date }): Promise<Reply> {
  const b = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  if (typeof b.on !== "boolean") return { status: 400, body: { error: "Send on (true or false)." } };
  let role: string | null = null;
  let schoolId: string | null = null;
  try {
    const p = rowsOf(await input.session.from("profiles").select("role, school_id").eq("id", input.userId).maybeSingle(), "profile")[0];
    role = typeof p?.role === "string" ? p.role : null;
    schoolId = typeof p?.school_id === "string" && p.school_id ? p.school_id : null;
  } catch (e) {
    console.error("[sk school-memory] profile read failed:", (e as Error).message);
    return { status: 500, body: { error: "This could not be changed. Please try again." } };
  }
  // The principal of THIS school only (the timetable settings' rule): a
  // coordinator, a teacher, a parent — anyone else — is refused, and the
  // school is always the caller's own, never one named in the body.
  if (role !== "school_admin" || !schoolId) return { status: 403, body: { error: "Only the school's principal can change this." } };
  if (b.schoolId !== undefined && b.schoolId !== schoolId) return { status: 403, body: { error: "You can only change this for your own school." } };

  let admin: SettingsDb;
  try {
    admin = input.admin();
  } catch (e) {
    return { status: 500, body: { error: (e as Error).message } };
  }
  try {
    const school = rowsOf(await admin.from("schools").select("id, config").eq("id", schoolId).maybeSingle(), "school")[0];
    if (!school) return { status: 404, body: { error: "School not found." } };
    const cfg = (school.config ?? {}) as Record<string, unknown>;
    const at = (input.now ?? new Date()).toISOString();
    // Merge: only our two keys change; everything else in config stays.
    const next = { ...cfg, sk_learning_memory: b.on, sk_learning_memory_changed: { by: input.userId, at } };
    const r = await admin.from("schools").update({ config: next }).eq("id", schoolId);
    if (r?.error) throw new Error(r.error.message ?? "update failed");
    return { status: 200, body: { ok: true, on: b.on, changedAt: at } };
  } catch (e) {
    console.error("[sk school-memory] write failed:", (e as Error).message);
    return { status: 500, body: { error: "This could not be changed. Please try again." } };
  }
}
