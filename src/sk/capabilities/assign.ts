// `assign` — SK's first confirm-tier action (Final Plan 2026-10-28 §2.5, §4
// "Assign work = confirm", §8.2, §9.2).
//
// This handler RESOLVES, it never writes. It turns "assign the cells worksheet
// to 7B, due Friday" into fully resolved parameters — the teacher's own class,
// the teacher's own done kit, an absolute due instant — and returns them as a
// `confirm` card. The turn route issues the action token over those params;
// the write happens only in /api/sk/act → migration 0164's one-transaction RPC,
// which re-checks both ownerships from the STORED params.
//
// Reads go through the USER-SESSION client only (§2.3) and reuse the resolve /
// library helpers, so the same ownership belt applies: a row that is not the
// caller's never becomes a parameter. Ambiguity asks; nothing is guessed.
//
// Due dates (documented in docs/sk-actions.md): the user's civil day in the
// collector clock's UTC offset (default +08:00, Kuala Lumpur), 17:00 local when
// no time is said. "Friday" = the coming Friday (1–7 days ahead); "next Friday"
// / "Jumaat depan" = the Friday of next calendar week; "tomorrow"/"esok",
// "today"/"hari ini", "in 3 days"/"3 hari lagi", ISO YYYY-MM-DD; a past due is
// refused, an unparsed one asks.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkCollector, SkContext } from "@/sk/shell/types";
import { cleanQuery, normalizeName, resolveEntities } from "./resolve";
import { searchLibrary, type LibraryHit } from "./library";

export const ASSIGN_DEFAULT_HOUR = 17;
export const ASSIGN_DEFAULT_OFFSET_MINUTES = 8 * 60; // Asia/Kuala_Lumpur, the product's home
/** The Library's own rule (dashboard/kit.ts assignableIds): done, and not one of these kinds. */
export const NOT_ASSIGNABLE_KINDS: ReadonlySet<string> = new Set(["lesson_plan", "question_bank"]);

// ── Due-date parsing (pure) ──────────────────────────────────────────────────

const WEEKDAYS: Array<[number, RegExp]> = [
  [1, /\b(?:monday|mon|isnin)\b/],
  [2, /\b(?:tuesday|tue|tues|selasa)\b/],
  [3, /\b(?:wednesday|wed|rabu)\b/],
  [4, /\b(?:thursday|thu|thur|thurs|khamis)\b/],
  [5, /\b(?:friday|fri|jumaat)\b/],
  [6, /\b(?:saturday|sat|sabtu)\b/],
  [0, /\b(?:sunday|sun|ahad)\b/],
];
const NEXT_RE = /\bnext\b|\bdepan\b|\bminggu depan\b|\bhadapan\b/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The browser's UTC offset in minutes, from the collector clock's ISO string
 *  ("2026-10-28T16:30:00+08:00" → 480; "…Z" → 0). Absent → Kuala Lumpur. */
export function offsetMinutesOf(clock?: SkCollector["clock"]): number {
  const iso = clock?.iso ?? "";
  if (/(?:Z|z)$/.test(iso)) return 0;
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return ASSIGN_DEFAULT_OFFSET_MINUTES;
  const n = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -n : n;
}

/** The user's civil date right now, as UTC fields of the shifted instant. */
function civilNow(now: Date, offsetMinutes: number): { y: number; m: number; d: number; weekday: number } {
  const s = new Date(now.getTime() + offsetMinutes * 60_000);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), weekday: s.getUTCDay() };
}

function timeOf(t: string): { hour: number; minute: number } | null {
  const ampm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (ampm[3] === "pm") hour += 12;
    return { hour, minute: Number(ampm[2] ?? 0) };
  }
  const pukul = t.match(/\b(?:pukul|jam|at|by)\s+(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:am|pm|hari|days?))/);
  if (pukul && Number(pukul[1]) <= 23) {
    let hour = Number(pukul[1]);
    if (/\b(?:petang|malam)\b/.test(t) && hour < 12) hour += 12;
    return { hour, minute: Number(pukul[2] ?? 0) };
  }
  if (/\b(?:noon|midday|tengah ?hari)\b/.test(t)) return { hour: 12, minute: 0 };
  return null;
}

export type DueParse = { ok: true; iso: string; label: string } | { ok: false; reason: "unparsed" | "past" };

/** "Fri 30 Oct, 17:00" in the user's offset. */
export function formatDue(iso: string, offsetMinutes: number): string {
  const s = new Date(new Date(iso).getTime() + offsetMinutes * 60_000);
  if (Number.isNaN(s.getTime())) return iso;
  const hh = String(s.getUTCHours()).padStart(2, "0");
  const mm = String(s.getUTCMinutes()).padStart(2, "0");
  return `${DAY_NAMES[s.getUTCDay()]} ${s.getUTCDate()} ${MONTH_NAMES[s.getUTCMonth()]}, ${hh}:${mm}`;
}

/** null = no due given. Never guesses: unknown words → unparsed; an instant
 *  at or before now → past. */
export function parseDue(text: string | null | undefined, now: Date, clock?: SkCollector["clock"]): DueParse | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, " ");
  const offset = offsetMinutesOf(clock);
  const today = civilNow(now, offset);
  const time = timeOf(t) ?? { hour: ASSIGN_DEFAULT_HOUR, minute: 0 };

  let dayDelta: number | null = null;
  let fixed: { y: number; m: number; d: number } | null = null;

  // A full ISO instant is taken as said.
  const isoInstant = raw.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (isoInstant) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: "unparsed" };
    if (d.getTime() <= now.getTime()) return { ok: false, reason: "past" };
    return { ok: true, iso: d.toISOString(), label: formatDue(d.toISOString(), offset) };
  }
  const isoDay = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDay) fixed = { y: Number(isoDay[1]), m: Number(isoDay[2]) - 1, d: Number(isoDay[3]) };
  else if (/\b(?:today|hari ini|tonight|malam ini)\b/.test(t)) dayDelta = 0;
  else if (/\b(?:day after tomorrow|lusa)\b/.test(t)) dayDelta = 2;
  else if (/\b(?:tomorrow|esok|besok)\b/.test(t)) dayDelta = 1;
  else {
    const inDays = t.match(/\b(?:in|dalam)\s+(\d{1,2})\s+(?:days?|hari)\b/) ?? t.match(/\b(\d{1,2})\s+hari\s+lagi\b/);
    if (inDays) dayDelta = Number(inDays[1]);
    else {
      const wd = WEEKDAYS.find(([, re]) => re.test(t));
      if (wd) {
        const target = wd[0];
        let delta = (target - today.weekday + 7) % 7;
        if (delta === 0) delta = 7; // a bare weekday is never today
        if (NEXT_RE.test(t)) {
          // The weekday of NEXT calendar week (Mon–Sun).
          const toNextMonday = ((1 - today.weekday + 7) % 7) || 7;
          delta = toNextMonday + ((target - 1 + 7) % 7);
        }
        dayDelta = delta;
      }
    }
  }
  if (fixed === null && dayDelta === null) return { ok: false, reason: "unparsed" };
  const base = fixed ?? { y: today.y, m: today.m, d: today.d + (dayDelta ?? 0) };
  const utc = Date.UTC(base.y, base.m, base.d, time.hour, time.minute) - offset * 60_000;
  if (!Number.isFinite(utc)) return { ok: false, reason: "unparsed" };
  if (utc <= now.getTime()) return { ok: false, reason: "past" };
  const iso = new Date(utc).toISOString();
  return { ok: true, iso, label: formatDue(iso, offset) };
}

// ── Resolution ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim().slice(0, 120) : "");
const rowsOf = async (q: unknown): Promise<Row[]> => {
  try {
    const r = (await q) as { data?: unknown } | null;
    return Array.isArray(r?.data) ? (r!.data as Row[]) : [];
  } catch {
    return [];
  }
};

type ClassPick = { kind: "none"; query: string } | { kind: "one"; id: string; name: string } | { kind: "many"; options: Array<{ id: string; name: string }> };

async function pickClass(ctx: SkContext, deps: SkCapabilityDeps, classId: string, classQuery: string): Promise<ClassPick> {
  const me = ctx.user.id;
  if (classId) {
    const rows = await rowsOf(deps.session.from("classes").select("id, name, teacher_id, school_id").eq("teacher_id", me).eq("id", classId));
    const own = rows.find((r) => r.id === classId && r.teacher_id === me);
    return own && typeof own.name === "string" ? { kind: "one", id: classId, name: own.name } : { kind: "none", query: classId };
  }
  const r = await resolveEntities(ctx, { query: classQuery, kind: "class" }, deps);
  const classes = (r.entities ?? []).filter((e) => e.kind === "class");
  if (!classes.length) return { kind: "none", query: classQuery };
  if (classes.length === 1) return { kind: "one", id: classes[0].id, name: classes[0].label };
  const exact = classes.filter((c) => normalizeName(c.label) === normalizeName(classQuery));
  if (exact.length === 1) return { kind: "one", id: exact[0].id, name: exact[0].label };
  return { kind: "many", options: classes.map((c) => ({ id: c.id, name: c.label })) };
}

type KitPick = { kind: "none"; query: string } | { kind: "one"; id: string; title: string } | { kind: "many"; options: Array<{ id: string; title: string }> };

const assignableHit = (h: LibraryHit) => h.kind === "kit" && h.where === "my_library" && h.status === "done" && !NOT_ASSIGNABLE_KINDS.has(h.kitKind ?? "");

/** The belt under the library search: re-read the candidate ids as OWN rows
 *  and keep only the ones that are the caller's, live, done and assignable —
 *  whatever the client returned (the RPC checks again from the stored params). */
async function ownAssignable(ctx: SkContext, deps: SkCapabilityDeps, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const me = ctx.user.id;
  const rows = await rowsOf(deps.session.from("generations").select("id, status, kind, owner_id, withdrawn_at").eq("owner_id", me).in("id", ids));
  const wanted = new Set(ids);
  return new Set(
    rows
      .filter((r) => typeof r.id === "string" && wanted.has(r.id) && r.owner_id === me && r.withdrawn_at == null && r.status === "done" && !NOT_ASSIGNABLE_KINDS.has(String(r.kind ?? "")))
      .map((r) => r.id as string),
  );
}

async function pickKit(ctx: SkContext, deps: SkCapabilityDeps, generationId: string, kitQuery: string): Promise<KitPick> {
  const me = ctx.user.id;
  if (generationId) {
    const rows = await rowsOf(
      deps.session.from("generations").select("id, title, status, kind, owner_id, withdrawn_at").eq("owner_id", me).eq("id", generationId),
    );
    const g = rows.find((r) => r.id === generationId && r.owner_id === me && r.withdrawn_at == null && r.status === "done" && !NOT_ASSIGNABLE_KINDS.has(String(r.kind ?? "")));
    return g ? { kind: "one", id: generationId, title: (typeof g.title === "string" && g.title) || `${g.kind ?? "kit"}` } : { kind: "none", query: generationId };
  }
  let hits: LibraryHit[] = [];
  try {
    hits = (await searchLibrary(ctx, deps, kitQuery, 40)).filter(assignableHit);
  } catch {
    hits = [];
  }
  const own = await ownAssignable(ctx, deps, hits.map((h) => h.id));
  hits = hits.filter((h) => own.has(h.id));
  if (!hits.length) return { kind: "none", query: kitQuery };
  if (hits.length === 1) return { kind: "one", id: hits[0].id, title: hits[0].title };
  const exact = hits.filter((h) => normalizeName(h.title) === normalizeName(kitQuery));
  if (exact.length === 1) return { kind: "one", id: exact[0].id, title: exact[0].title };
  return { kind: "many", options: hits.slice(0, 5).map((h) => ({ id: h.id, title: h.title })) };
}

export async function resolveAssign(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const classId = str(args, "classId");
  const classQuery = cleanQuery(args.classQuery);
  const generationId = str(args, "generationId");
  const kitQuery = cleanQuery(args.kitQuery);
  const due = str(args, "due");
  if (!classId && !classQuery) return { ok: false, summary: "Which class should I assign it to?", error: "class required", facts: [] };
  if (!generationId && !kitQuery) return { ok: false, summary: "Which kit or worksheet should I assign?", error: "kit required", facts: [] };

  const parsed = parseDue(due, deps.now, deps.clock);
  if (parsed && !parsed.ok) {
    return parsed.reason === "past"
      ? { ok: false, summary: `"${due}" is already past — when should it be due?`, error: "due_past", facts: [] }
      : { ok: false, summary: `I didn't catch the due date "${due}" — say a day like Friday, tomorrow, or 2026-11-03.`, error: "due_unparsed", facts: [] };
  }

  const cls = await pickClass(ctx, deps, classId, classQuery);
  if (cls.kind === "none") return { ok: false, summary: `I can't find a class called "${cls.query}" among yours.`, error: "class_not_found", facts: [] };
  if (cls.kind === "many") {
    const names = cls.options.map((o) => o.name);
    return {
      ok: true,
      summary: `Which class: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?`,
      facts: cls.options.map((o) => ({ kind: "class", id: o.id, name: o.name })),
      entities: cls.options.map<ResolvedEntity>((o) => ({ kind: "class", id: o.id, label: o.name, via: "assign" })),
    };
  }

  const kit = await pickKit(ctx, deps, generationId, kitQuery);
  if (kit.kind === "none") return { ok: false, summary: `I can't find a finished kit or worksheet matching "${kit.query}" in your library.`, error: "kit_not_found", facts: [] };
  if (kit.kind === "many") {
    const titles = kit.options.map((o) => o.title);
    return {
      ok: true,
      summary: `Which one: ${titles.slice(0, -1).join(", ")} or ${titles[titles.length - 1]}?`,
      facts: kit.options.map((o) => ({ kind: "kit", id: o.id, title: o.title })),
      entities: kit.options.map<ResolvedEntity>((o) => ({ kind: "generation", id: o.id, label: o.title, via: "assign" })),
    };
  }

  const dueText = parsed?.ok ? `, due ${parsed.label}` : "";
  const title = `Assign ${kit.title} to ${cls.name}${dueText}?`;
  return {
    ok: true,
    summary: title,
    facts: [{ kind: "assign", generation_id: kit.id, kit_title: kit.title, class_id: cls.id, class_name: cls.name, due_at: parsed?.ok ? parsed.iso : null }],
    entities: [
      { kind: "class", id: cls.id, label: cls.name, via: "assign" },
      { kind: "generation", id: kit.id, label: kit.title, via: "assign" },
    ],
    confirm: {
      action: "assign",
      title,
      params: { generation_id: kit.id, class_id: cls.id, due_at: parsed?.ok ? parsed.iso : null, class_name: cls.name, kit_title: kit.title },
    },
  };
}

export const assignAction: SkCapability = {
  meta: {
    name: "assign",
    description:
      "Assign one of the teacher's own finished kits or worksheets to one of their own classes, optionally with a due date. Resolves the class and the kit and returns a confirmation card — nothing is assigned until the teacher confirms it. Give the class as the teacher said it (classQuery, e.g. '7B') or its id, the kit by title words (kitQuery) or its id, and the due date in the teacher's words (due: 'Friday', 'tomorrow', 'next Monday', '2026-11-03', 'Jumaat'). If more than one class or kit matches, the result asks which — pass the answer back, never guess.",
    parameters: {
      type: "object",
      properties: {
        classQuery: { type: "string", description: "The class name as the user said it, e.g. '7B'." },
        classId: { type: "string", description: "A class id already resolved this conversation." },
        kitQuery: { type: "string", description: "Title or topic words of the kit or worksheet." },
        generationId: { type: "string", description: "A kit id already resolved this conversation." },
        due: { type: "string", description: "The due date in the user's words; omit when none was given." },
      },
      additionalProperties: false,
    },
    tier: "confirm",
    kind: "act",
    roles: ["teacher"],
    hats: ["teacher"],
  },
  handler: resolveAssign,
};
