// Availability — the one vocabulary for "do we have a lesson on X?" (SK Final
// Plan 2026-10-28 §4 row 1, §6 S0). The founder's words, made precise:
//
//   in_library              a kit or book of the teacher's own matches
//   on_school_shelf         a book on the school's shared shelf matches
//   in_catalogue_unlocked   a catalogue kit matches and the teacher has unlocked it
//   sk_book_activated       a printed SK study guide matches and the teacher holds a live access grant
//   in_catalogue            a catalogue kit matches; whether it is unlocked is NOT visible to this session
//   in_catalogue_locked     a catalogue kit matches and the teacher has not unlocked it
//   sk_book_not_activated   a printed SK study guide matches; no live grant
//   in_catalogue_not_yet    the topic exists in the catalogue but has no current kit
//   not_found               nothing matched anywhere
//
// That is also the DECISION ORDER (best first): what she can use right now
// (library, shelf, unlocked kit, activated book), then what she can obtain
// (a kit whose lock we cannot see, a locked kit, a book to activate), then
// what is only promised (not yet), then nothing. `decideAvailability` returns
// one row per match in that order, so the first row IS the answer.
//
// Why `in_catalogue` exists: `public_catalogue()` withholds topic ids and
// `topics` / `topic_kits` grant nothing to `authenticated`, so a user session
// can read its own `catalogue_unlocks` (topic ids) but cannot map a public slug
// onto them. A teacher with NO unlock rows is certainly locked everywhere; a
// teacher with some is "unknown" for any given kit — and §2.3 says a tool
// never guesses, so the unknown gets its own honest state rather than a coin
// toss between locked and unlocked.
//
// PURE: rows in, decision out. No Supabase, no clock of its own.

export type AvailabilityState =
  | "in_library"
  | "on_school_shelf"
  | "in_catalogue_unlocked"
  | "sk_book_activated"
  | "in_catalogue"
  | "in_catalogue_locked"
  | "sk_book_not_activated"
  | "in_catalogue_not_yet"
  | "not_found";

/** Best first. Index = rank. */
export const AVAILABILITY_ORDER: readonly AvailabilityState[] = [
  "in_library",
  "on_school_shelf",
  "in_catalogue_unlocked",
  "sk_book_activated",
  "in_catalogue",
  "in_catalogue_locked",
  "sk_book_not_activated",
  "in_catalogue_not_yet",
  "not_found",
];

export const availabilityRank = (s: AvailabilityState): number => AVAILABILITY_ORDER.indexOf(s);

// ── Text matching (shared with library.find) ─────────────────────────────────

/** Lowercase, strip punctuation (keeping Arabic, Devanagari and Telugu
 *  letters like school-books does), collapse spaces. */
export function normText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿऀ-ॿఀ-౿ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Query tokens worth matching on: three letters or more, so "of" and "a" do
 *  not match everything; a query made only of short words keeps them all. */
export function queryTokens(query: string): string[] {
  const all = normText(query).split(" ").filter(Boolean);
  const long = all.filter((t) => t.length >= 3);
  return long.length ? long : all;
}

/**
 * Does the query match any of the fields? Either the whole normalised query is
 * a substring of a field, or EVERY token of the query appears in the fields
 * joined ("specialised cells" matches "Cells — specialised cells and tissues";
 * "cell biology" matches a book titled "Biology" with chapter "The cell").
 */
export function textMatches(query: string, fields: Array<string | null | undefined>): boolean {
  const q = normText(query);
  if (!q) return false;
  const hay = fields.map((f) => normText(f)).filter(Boolean);
  if (!hay.length) return false;
  if (hay.some((h) => h.includes(q))) return true;
  const joined = hay.join(" | ");
  return queryTokens(query).every((t) => joined.includes(t));
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/** A book or kit of the teacher's own, or a book on the school shelf, that
 *  ALREADY matched the topic (library.find's rows). */
export type LibraryMatch = {
  kind: "book" | "kit";
  id: string;
  title: string;
  where: "my_library" | "school_shelf";
  subject: string | null;
};

/** A row of public_catalogue() that matched the topic (slug is the public id). */
export type CatalogueMatch = {
  slug: string;
  title: string;
  subject: string | null;
  language: string;
  /** true / false when the session can tell; null when it cannot (see header). */
  unlocked: boolean | null;
};

/** A catalogue topic with no current kit (not observable through
 *  public_catalogue(), which lists only topics WITH a kit — kept for the
 *  vocabulary and for a future reader that can see topics). */
export type CatalogueTopicOnly = { slug: string; title: string; subject: string | null };

/** sk_book_products row that matched the topic + whether a live grant covers it. */
export type SkBookMatch = { id: string; slug: string; title: string; subject: string | null; activated: boolean };

/** my_catalogue_allowance() as the kits page reads it (null when the RPC failed). */
export type UnlockAllowance = {
  eligible: boolean;
  reason: string | null;
  tier: string;
  cap: number | null;
  used: number;
  resets_at: string | null;
};

export type AvailabilityInput = {
  topic: string;
  library: LibraryMatch[];
  catalogue: CatalogueMatch[];
  catalogueTopicsOnly?: CatalogueTopicOnly[];
  skBooks: SkBookMatch[];
  allowance: UnlockAllowance | null;
};

/** One flat row per match — the shape SkCapabilityResult.facts takes. */
export type AvailabilityRow = {
  state: AvailabilityState;
  rank: number;
  kind: "book" | "kit" | "catalogue_kit" | "catalogue_topic" | "sk_book" | null;
  id: string | null;
  title: string | null;
  subject: string | null;
  language: string | null;
  /** Unlock allowance, only on catalogue rows that are not unlocked. */
  unlockEligible: boolean | null;
  unlockUsed: number | null;
  unlockCap: number | null;
  unlockResetsAt: string | null;
  unlockReason: string | null;
};

export type AvailabilityDecision = {
  /** The first row's state; "not_found" when nothing matched. */
  state: AvailabilityState;
  rows: AvailabilityRow[];
  summary: string;
};

const blankUnlock = { unlockEligible: null, unlockUsed: null, unlockCap: null, unlockResetsAt: null, unlockReason: null };

const unlockCols = (a: UnlockAllowance | null) =>
  a
    ? { unlockEligible: a.eligible, unlockUsed: a.used, unlockCap: a.cap, unlockResetsAt: a.resets_at, unlockReason: a.reason }
    : blankUnlock;

const q = (s: string) => `'${s.replace(/\s+/g, " ").trim().slice(0, 80)}'`;

/** The month-or-week word for the allowance window: the RPC's cap is weekly
 *  today (catalogue_weekly_cap), so say "this week". */
function unlockPhrase(a: UnlockAllowance | null): string {
  if (!a) return "";
  if (!a.eligible) {
    if (a.reason === "coming_soon") return " Unlocking is not open yet.";
    if (a.reason === "suspended") return " Your account cannot unlock kits right now.";
    if (a.reason === "forbidden_role") return " Your role cannot unlock kits.";
    return " You cannot unlock kits right now.";
  }
  if (a.cap === null) return " You can unlock it now.";
  return a.used < a.cap ? ` ${a.used} of ${a.cap} unlocks used this week.` : ` All ${a.cap} unlocks used this week.`;
}

function summaryFor(best: AvailabilityRow | undefined, topic: string, allowance: UnlockAllowance | null, count: number): string {
  const t = q(topic);
  if (!best) return `No — nothing matches ${t} in your library, the school shelf, the catalogue or the SK books.`;
  const title = q(best.title ?? topic);
  const more = count > 1 ? ` (${count} matches in all)` : "";
  switch (best.state) {
    case "in_library":
      return `Yes — ${title} is in your library (${best.kind === "kit" ? "a kit" : "a book"})${more}.`;
    case "on_school_shelf":
      return `Yes — ${title} is on the school shelf${more}.`;
    case "in_catalogue_unlocked":
      return `Yes — ${title} is in the catalogue and unlocked${more}.`;
    case "sk_book_activated":
      return `Yes — the SK book ${title} is activated for you${more}.`;
    case "in_catalogue":
      return `There is a catalogue kit ${title}; whether you have unlocked it is not visible from here — open Kits to check.${unlockPhrase(allowance)}`;
    case "in_catalogue_locked":
      return `There is a kit ${title} but it is locked.${unlockPhrase(allowance)}`;
    case "sk_book_not_activated":
      return `The SK book ${title} exists but is not activated for you.`;
    case "in_catalogue_not_yet":
      return `${title} is a catalogue topic but has no kit yet.`;
    default:
      return `No — nothing matches ${t}.`;
  }
}

/** The vocabulary applied. Rows come back best first (see header). */
export function decideAvailability(input: AvailabilityInput): AvailabilityDecision {
  const rows: AvailabilityRow[] = [];
  const push = (state: AvailabilityState, rest: Omit<AvailabilityRow, "state" | "rank">) =>
    rows.push({ state, rank: availabilityRank(state), ...rest });

  for (const m of input.library) {
    push(m.where === "my_library" ? "in_library" : "on_school_shelf", {
      kind: m.kind,
      id: m.id,
      title: m.title,
      subject: m.subject,
      language: null,
      ...blankUnlock,
    });
  }
  for (const c of input.catalogue) {
    const state: AvailabilityState = c.unlocked === true ? "in_catalogue_unlocked" : c.unlocked === false ? "in_catalogue_locked" : "in_catalogue";
    push(state, {
      kind: "catalogue_kit",
      id: c.slug,
      title: c.title,
      subject: c.subject,
      language: c.language,
      ...(state === "in_catalogue_unlocked" ? blankUnlock : unlockCols(input.allowance)),
    });
  }
  for (const b of input.skBooks) {
    push(b.activated ? "sk_book_activated" : "sk_book_not_activated", {
      kind: "sk_book",
      id: b.id,
      title: b.title,
      subject: b.subject,
      language: null,
      ...blankUnlock,
    });
  }
  for (const t of input.catalogueTopicsOnly ?? []) {
    push("in_catalogue_not_yet", { kind: "catalogue_topic", id: t.slug, title: t.title, subject: t.subject, language: null, ...blankUnlock });
  }

  // Stable: rank first, then the order the caller supplied (own matches are
  // already newest-first from the library reads).
  rows.sort((a, b) => a.rank - b.rank);
  const best = rows[0];
  return { state: best?.state ?? "not_found", rows, summary: summaryFor(best, input.topic, input.allowance, rows.length) };
}
