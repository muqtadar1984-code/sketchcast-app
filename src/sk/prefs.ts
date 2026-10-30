// SK S6 slice C — the SK preferences as WORKFLOW FACTS (Final Plan §9.5:
// "preferences" are workflow memory, the adult's own, 12 months rolling).
//
// Before S6 they were localStorage flags in the panel only (sk-shell.tsx:
// `sk.readAloud`, `sk.handsFree`), so they never followed a user to another
// device. Now each is one sk_workflow_facts row — kind "preference", key
// "read_aloud" | "hands_free" | "suggestions" | "mic_on" | "show_text" | "look_a", value { on: boolean } — written
// through the user's own session (RLS owner-only; facts.ts rememberWorkflow).
//
// PURE and client-safe: no server imports. The panel (client) and the
// settings page / routes (server) both use it.
//
// MIGRATION (once per browser): when the server holds NO stored value for a
// preference and this browser has a localStorage value, the local value wins
// and is written up; after that the server is the source of truth and the
// localStorage copy is only a fast first paint. `resolvePrefs` decides it.

export type SkPrefs = { readAloud: boolean; handsFree: boolean; suggestions: boolean; micOn: boolean; showText: boolean; lookA: boolean };
export type SkPrefKey = keyof SkPrefs;

/** The defaults the panel had before S6 (read aloud on, hands-free off) plus
 *  the S6 suggestions switch (design decision 5: on by default), the Mic
 *  switch (founder 2026-10-30: on — but see defaultMicOn: the default depends
 *  on the role, so callers that know it use defaultsFor) and "show text"
 *  (founder 2026-10-30: SK is a corner avatar with a speech bubble; the
 *  conversation's text stays hidden by default — on opens it on each page)
 *  and SK's character (lookA: true = look A, the woman teacher with the
 *  female voice; false = look B, the man teacher with the male voice — the
 *  default, board/avatar.ts DEFAULT_RIG). */
export const DEFAULT_PREFS: SkPrefs = { readAloud: true, handsFree: false, suggestions: true, micOn: true, showText: false, lookA: false };

/** Founder 2026-10-30: the home hero's mic is ON by default for every adult
 *  role (teacher, parent, principal / coordinator, school admin, the founder)
 *  and OFF for a student. A saved choice always wins over this, either way. */
export function defaultMicOn(role: string | null | undefined): boolean {
  return role !== "student";
}

/** The defaults for this role (only micOn depends on it). */
export function defaultsFor(role?: string | null): SkPrefs {
  return { ...DEFAULT_PREFS, micOn: defaultMicOn(role) };
}

export const PREF_KIND = "preference";
/** Preference → its sk_workflow_facts key. */
export const PREF_FACT_KEY: Record<SkPrefKey, string> = { readAloud: "read_aloud", handsFree: "hands_free", suggestions: "suggestions", micOn: "mic_on", showText: "show_text", lookA: "look_a" };
export const PREF_KEYS: readonly SkPrefKey[] = ["readAloud", "handsFree", "suggestions", "micOn", "showText", "lookA"];
/** The localStorage keys the panel has used since S0 (suggestions, micOn and
 *  showText are new). lookA is the rig's own key (board/avatar.ts
 *  RIG_CHOICE_KEY, "sk:rig"), which holds "A" / "B", not "on" / "off" — read
 *  and write it through parseLocalPref / localPrefValue. */
export const PREF_LOCAL_KEY: Record<SkPrefKey, string> = { readAloud: "sk.readAloud", handsFree: "sk.handsFree", suggestions: "sk.suggestions", micOn: "sk.micOn", showText: "sk.showText", lookA: "sk:rig" };
/** Set once this browser's local values have been written to the server. */
export const PREFS_MIGRATED_LOCAL_KEY = "sk.prefsMigrated";
/** lookA joined later, and its local value ("sk:rig") predates S6: a browser
 *  that already migrated the others (sk.prefsMigrated = "1") still holds a
 *  look she chose, so it migrates once under its OWN marker — otherwise the
 *  warm start would reset her look to the default. */
export const LOOK_MIGRATED_LOCAL_KEY = "sk.lookMigrated";
/** The marker that says this preference's local value was already migrated. */
export const migratedLocalKey = (k: SkPrefKey): string => (k === "lookA" ? LOOK_MIGRATED_LOCAL_KEY : PREFS_MIGRATED_LOCAL_KEY);
/** Every marker: all set once a migration (or a server read with nothing to migrate) completes. */
export const MIGRATED_LOCAL_KEYS: readonly string[] = [PREFS_MIGRATED_LOCAL_KEY, LOOK_MIGRATED_LOCAL_KEY];

/** What the server holds: a value per preference, or absent when never stored. */
export type StoredPrefs = Partial<SkPrefs>;

const KEY_TO_PREF = new Map<string, SkPrefKey>(PREF_KEYS.map((k) => [PREF_FACT_KEY[k], k]));

/** The stored preferences out of a list of workflow facts (any kinds mixed in). */
export function prefsFromFacts(facts: ReadonlyArray<{ kind: string; key: string; value: unknown }>): StoredPrefs {
  const out: StoredPrefs = {};
  for (const f of facts) {
    if (f.kind !== PREF_KIND) continue;
    const k = KEY_TO_PREF.get(f.key);
    const on = (f.value as { on?: unknown } | null)?.on;
    if (k && typeof on === "boolean" && out[k] === undefined) out[k] = on;
  }
  return out;
}

/** A complete preference set: stored values over the defaults (the role's,
 *  when given — see defaultMicOn). */
export function withDefaults(stored: StoredPrefs | null | undefined, role?: string | null): SkPrefs {
  return { ...defaultsFor(role), ...pick(stored ?? {}) };
}

/** Only well-formed boolean values of known keys. */
export function pick(v: unknown): StoredPrefs {
  const out: StoredPrefs = {};
  if (!v || typeof v !== "object") return out;
  for (const k of PREF_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === "boolean") out[k] = x;
  }
  return out;
}

/** "on" / "off" as the panel stored it; anything else → undefined. */
export function parseLocalFlag(v: string | null | undefined): boolean | undefined {
  return v === "on" ? true : v === "off" ? false : undefined;
}

/** One preference's localStorage value → boolean (undefined when absent or
 *  unknown). lookA's key holds the rig's letter: "A" → true, "B" → false. */
export function parseLocalPref(k: SkPrefKey, v: string | null | undefined): boolean | undefined {
  if (k === "lookA") {
    const s = (v ?? "").trim().toUpperCase();
    return s === "A" ? true : s === "B" ? false : undefined;
  }
  return parseLocalFlag(v);
}

/** The localStorage value that stores `on` for this preference. */
export function localPrefValue(k: SkPrefKey, on: boolean): string {
  if (k === "lookA") return on ? "A" : "B";
  return on ? "on" : "off";
}

/** SK's character as the rig's letter (board/avatar.ts RigChoice). */
export type Look = "A" | "B";
export const lookOf = (lookA: boolean): Look => (lookA ? "A" : "B");

/** She picks a look (the avatar's menu): choose it — the avatar, the voice
 *  gender and every reader of the rig follow — AND save the preference so it
 *  follows her to her other devices. Nothing happens when it is already the
 *  current look. Returns whether it changed. */
export function pickLook(value: string, current: Look, choose: (c: Look) => void, save: (patch: StoredPrefs) => unknown): boolean {
  const next: Look = value === "A" ? "A" : "B";
  if (next === current) return false;
  choose(next);
  void save({ lookA: next === "A" });
  return true;
}

/** The warm start: the resolved lookA applied to the rig, only when it
 *  differs (no "B" stored for a default nobody chose). Returns whether it changed. */
export function applyLook(prefs: Pick<SkPrefs, "lookA">, current: Look, choose: (c: Look) => void): boolean {
  const next = lookOf(prefs.lookA);
  if (next === current) return false;
  choose(next);
  return true;
}

export type ResolvedPrefs = {
  prefs: SkPrefs;
  /** The values to write to the server now (the one-time migration); empty → nothing to send. */
  migrate: StoredPrefs;
};

/**
 * The panel's preferences after the warm start. `stored` is what the server
 * holds (null = the server could not be read: keep local, migrate nothing —
 * a failed read must never overwrite the server later with stale values);
 * `local` is this browser's localStorage; `migrated` says the one-time copy
 * already happened in this browser — one answer for every preference, or
 * per preference (migratedLocalKey: lookA has its own marker).
 *   stored value present → it wins;
 *   stored value absent, local present, not yet migrated → local wins AND is migrated;
 *   otherwise → the default (the role's, when `role` is given).
 * The panel writes the local copy back from `prefs` afterwards, so the next
 * first paint matches.
 */
export function resolvePrefs(stored: StoredPrefs | null, local: StoredPrefs, migrated: boolean | ((k: SkPrefKey) => boolean), role?: string | null): ResolvedPrefs {
  const done = typeof migrated === "function" ? migrated : () => migrated;
  if (stored === null) return { prefs: withDefaults(local, role), migrate: {} };
  const prefs: SkPrefs = defaultsFor(role);
  const migrate: StoredPrefs = {};
  for (const k of PREF_KEYS) {
    const s = stored[k];
    const l = local[k];
    if (typeof s === "boolean") prefs[k] = s;
    else if (typeof l === "boolean" && !done(k)) {
      prefs[k] = l;
      migrate[k] = l;
    }
    // Migrated before and now absent on the server (the user deleted their SK
    // memory, or the 12 months ran out): the default, not the stale local copy.
  }
  return { prefs, migrate };
}
