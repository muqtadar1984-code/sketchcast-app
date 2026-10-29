import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { skEnabled, skShellEnabledFor } from "@/utils/flags";
import { LOCALE_COOKIE, isLocale } from "@/i18n/locales";
import { loadContext } from "@/sk/shell/context";
import { openAnnounced, openMemory, rememberAnnounced, sealAnnounced, sealMemory, verifyMemory } from "@/sk/shell/memory";
import { allowedFor } from "@/sk/shell/registry";
import { SK_SHELL_PROMPT_VERSION, shellGreeting } from "@/sk/shell/prompt";
import { kitNotices } from "@/sk/shell/kit-tray";
import { tutorGreeting } from "@/sk/shell/tutor-greeting";
import type { SkCollector } from "@/sk/shell/types";
// S6 slice C: the preferences (workflow facts), the ONE greeting suggestion,
// and the workflow memory (a lapsed conversation's pending task).
import { recallWorkflow, type FactsDb, type WorkflowFact } from "@/sk/facts";
import { prefsFromFacts, withDefaults, type StoredPrefs } from "@/sk/prefs";
import { greetingSuggestion } from "@/sk/shell/suggest";
import { pendingToSave, recordWorkflow } from "@/sk/shell/workflow";

export const runtime = "nodejs";

// /api/sk/shell/context — the Shell's warm start (S0). Same gate as the turn
// route; returns readiness, the localised greeting, the capability names this
// user may use on this page, and the signed memory blob to echo on the first
// turn.
//
// S2 (job tray, "the next greeting"): POST {path, memory?, announced?} — the
// panel sends the conversation it carries and the signed note of kits already
// announced. When an SK-started kit has finished or failed since, the greeting
// LEADS with one line per kit (at most 2, kit-tray.ts kitNotices — time-boxed,
// skipped silently on error), the kit ids are recorded in the memory blob and
// the note, and the first ready kit becomes the blob's one-turn `offer` so
// "yes" / "open it" opens it. The memory returned is the conversation's own
// when it still applies (openMemory's rules), else a fresh one. GET (no body)
// still works: no carried conversation, nothing announced yet.

// S3 slice D: a STUDENT gets the tutor greeting instead (tutor-greeting.ts):
// "Hi Aisha — you were on <section> of <kit>. Carry on?" (the panel sends the
// kit player's state as `tutor`), else her chapters; the "Carry on?" offer
// rides in the memory blob like the kit tray's. No kit notices for a student.

// S6 slice C: after the kit notices and the tutor greeting, at most ONE
// suggestion line (src/sk/shell/suggest.ts - every rule is there): only with
// the user's `suggestions` preference on, never when the kit notices (or the
// tutor's "Carry on?") already filled the greeting, built from a tool read of
// THIS request, recorded in the announced note so it never repeats, time-boxed,
// skipped silently on error. Its offer (if any) rides in the blob like the kit
// tray's. The reply also carries `prefs`: the preferences the SERVER holds
// (null when they could not be read), which the panel resolves against its
// localStorage (prefs.ts resolvePrefs - the one-time migration). The panel
// may send `clock` (the browser's day/minutes) for "starts in 10 min".
// NOTHING is sent anywhere: the line exists only in this response.

/** The workflow kinds one warm start reads (one query). */
const WARM_KINDS = ["preference", "recent_kit", "recent_class", "pending_task"] as const;
const FACTS_TIMEOUT_MS = 1500;

/** The user's workflow facts, or null when they cannot be read (0173 not
 *  applied, a slow read, an error) - never throws, never holds the greeting. */
async function warmFacts(session: FactsDb, userId: string, now: Date): Promise<WorkflowFact[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FACTS_TIMEOUT_MS);
  });
  try {
    const work = recallWorkflow(session, userId, WARM_KINDS, now);
    const r = await Promise.race([work, slow]);
    if (r === null) work.catch(() => undefined);
    return r;
  } catch (e) {
    console.warn("sk-shell.greeting workflow facts skipped:", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type ContextInput = { path: string; memory?: string; announced?: string; tutor?: SkCollector["tutor"]; clock?: SkCollector["clock"] };

async function warmStart(input: ContextInput) {
  if (!skEnabled()) return NextResponse.json({ ready: false, error: "Not available." }, { status: 404 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ready: false, error: "Not signed in." }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!(await skShellEnabledFor(supabase, user, role, schoolId))) {
    return NextResponse.json({ ready: false, error: "Not available." }, { status: 404 });
  }

  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  const now = new Date();
  const ctx = await loadContext({
    session: supabase,
    admin,
    cookies: cookieStore,
    user,
    profile: { role, school_id: schoolId },
    collector: { path: input.path, ...(input.tutor ? { tutor: input.tutor } : {}) },
    locale: isLocale(localeCookie) ? localeCookie : "en",
    now,
  });

  // What was announced before: the carried conversation's list (any blob WE
  // signed — even one too old to continue) and the long-lived note.
  const prior = [...new Set([...(verifyMemory(input.memory)?.announced ?? []), ...openAnnounced(input.announced, ctx.user.id)])];
  const student = ctx.user.role === "student";
  const factsP = warmFacts(supabase as unknown as FactsDb, ctx.user.id, now);
  const notices = student ? { lines: [] as string[], ids: [] as string[], entities: [], offer: null } : await kitNotices(ctx, { session: supabase, now }, prior);
  const tutor = student ? await tutorGreeting(ctx, supabase) : null;
  const facts = await factsP;
  const stored: StoredPrefs | null = facts ? prefsFromFacts(facts) : null;

  // S6 slice C: a conversation that lapsed while SK waited on an answer -> a
  // pending_task fact (adults only; workflow.ts decides).
  const pendingNote = student ? null : pendingToSave(input.memory, ctx, now);
  if (pendingNote) await recordWorkflow(supabase as unknown as FactsDb, ctx.user.id, [pendingNote], { now });

  const suggestion = await greetingSuggestion({
    ctx,
    deps: { session: supabase, now, ...(input.clock ? { clock: input.clock } : {}), cache: new Map() },
    announced: prior,
    enabled: withDefaults(stored).suggestions,
    filled: notices.lines.length > 0 || !!tutor?.offer,
    workflow: (facts ?? []).filter((f) => f.kind !== "preference"),
  });
  const opened = openMemory(input.memory, ctx, now).memory;
  const base = suggestion?.pending && !opened.pending ? { ...opened, pending: suggestion.pending } : opened;
  const memory = rememberAnnounced(base, {
    ids: [...notices.ids, ...(suggestion ? [suggestion.id] : [])],
    prior,
    entities: notices.entities,
    offer: tutor?.offer ?? notices.offer ?? suggestion?.offer ?? null,
  });
  const lines = tutor ? [tutor.text, ...(suggestion ? [suggestion.line] : [])] : [...notices.lines, ...(suggestion ? [suggestion.line] : []), shellGreeting(ctx.user.locale)];

  return NextResponse.json({
    ready: true,
    greeting: lines.join("\n"),
    capabilities: allowedFor(ctx).map((c) => c.meta.name),
    memory: sealMemory(memory),
    sessionId: memory.sessionId,
    announced: sealAnnounced(ctx.user.id, memory.announced ?? []),
    role: ctx.user.role,
    hat: ctx.user.hat,
    page: ctx.place.page,
    locale: ctx.user.locale,
    promptVersion: SK_SHELL_PROMPT_VERSION,
    prefs: stored,
  });
}

const pathOf = (v: unknown): string => (typeof v === "string" && v ? v : "/dashboard").slice(0, 300);
const blobOf = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

export async function GET(request: Request) {
  return warmStart({ path: pathOf(new URL(request.url).searchParams.get("path")) });
}

export async function POST(request: Request) {
  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tutor = b.tutor && typeof b.tutor === "object" ? (b.tutor as SkCollector["tutor"]) : undefined;
  const c = (b.clock && typeof b.clock === "object" ? b.clock : null) as Record<string, unknown> | null;
  const clock =
    c && typeof c.day === "number" && typeof c.minutes === "number" && typeof c.iso === "string" && c.day >= 1 && c.day <= 7 && c.minutes >= 0 && c.minutes < 1440
      ? { day: c.day, minutes: c.minutes, iso: c.iso.slice(0, 40) }
      : undefined;
  return warmStart({ path: pathOf(b.path), memory: blobOf(b.memory, 64_000), announced: blobOf(b.announced, 4_000), tutor, clock });
}
