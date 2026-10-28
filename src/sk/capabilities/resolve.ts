// `context.resolve` — entity lookup (Final Plan §2.1, §5.4): a class by name
// ("7B"), a learner by name within the user's own classes (or a parent's
// linked children), a book by title. Reads go through the USER-SESSION client
// only (§2.3), and every result is re-filtered in code by ownership — RLS is
// the gate, this is the belt: a row that is not the caller's never becomes an
// entity, whatever the client returned.

import type { ResolvedEntity, SkCapability, SkCapabilityDeps, SkCapabilityResult, SkContext } from "@/sk/shell/types";

export type ResolveKind = "class" | "learner" | "book" | "any";

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.']/g, "");
}

/** Does a class name match a spoken token? "7B" ≈ "7 B" ≈ "Year 7B" ≈ "7B Amanah". */
export function classNameMatches(name: string, query: string): boolean {
  const n = normalizeName(name);
  const q = normalizeName(query);
  if (!n || !q) return false;
  if (n === q) return true;
  const stripped = n.replace(/^(year|grade|form|class|kelas|tahun|tingkatan|darjah)/, "");
  if (stripped === q) return true;
  // A short code like "7b" must sit at a token boundary of the longer name.
  const tokens = name.toLowerCase().split(/[\s\-_/]+/).map(normalizeName).filter(Boolean);
  if (tokens.includes(q)) return true;
  return q.length >= 3 && n.includes(q);
}

export function cleanQuery(v: unknown): string {
  return typeof v === "string" ? v.replace(/[%_,()\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

type Row = Record<string, unknown>;
const rowsOf = async (q: unknown): Promise<Row[]> => {
  try {
    const r = (await q) as { data?: unknown } | null;
    return Array.isArray(r?.data) ? (r!.data as Row[]) : [];
  } catch {
    return [];
  }
};

export async function resolveEntities(ctx: SkContext, args: Record<string, unknown>, deps: SkCapabilityDeps): Promise<SkCapabilityResult> {
  const query = cleanQuery(args.query);
  const kind: ResolveKind = args.kind === "class" || args.kind === "learner" || args.kind === "book" ? args.kind : "any";
  if (!query) return { ok: false, summary: "Nothing to look up.", error: "empty_query", facts: [] };
  const me = ctx.user.id;
  const school = ctx.user.schoolId;
  const mine = (r: Row, owner: string) => r[owner] === me && (!school || !r.school_id || r.school_id === school);
  const entities: ResolvedEntity[] = [];
  const facts: Array<Record<string, string | number | boolean | null>> = [];
  const canTeach = ctx.user.role !== "student" && ctx.user.role !== "parent";

  let myClasses: Row[] = [];
  if (canTeach && (kind === "class" || kind === "learner" || kind === "any")) {
    myClasses = (await rowsOf(deps.session.from("classes").select("id, name, teacher_id, school_id").eq("teacher_id", me))).filter((r) =>
      mine(r, "teacher_id"),
    );
  }
  if (kind === "class" || kind === "any") {
    for (const c of myClasses) {
      if (typeof c.name === "string" && typeof c.id === "string" && classNameMatches(c.name, query)) {
        entities.push({ kind: "class", id: c.id, label: c.name, via: "context.resolve" });
        facts.push({ kind: "class", id: c.id, name: c.name });
      }
    }
  }
  if (kind === "learner" || kind === "any") {
    const q = query.toLowerCase();
    if (canTeach && myClasses.length) {
      const ids = new Set(myClasses.map((c) => c.id as string));
      const enr = await rowsOf(deps.session.from("enrollments").select("class_id, student_id, profiles(full_name, username)"));
      const seen = new Set<string>();
      for (const e of enr) {
        if (!ids.has(e.class_id as string) || typeof e.student_id !== "string" || seen.has(e.student_id)) continue;
        const p = (e.profiles ?? null) as { full_name?: string | null; username?: string | null } | null;
        const label = (p?.full_name || p?.username || "").trim();
        if (label && label.toLowerCase().includes(q)) {
          seen.add(e.student_id);
          const cls = myClasses.find((c) => c.id === e.class_id);
          entities.push({ kind: "learner", id: e.student_id, label, via: "context.resolve" });
          facts.push({ kind: "learner", id: e.student_id, name: label, class: (cls?.name as string | null) ?? null });
        }
      }
    } else if (ctx.user.role === "parent") {
      const links = await rowsOf(deps.session.from("parent_links").select("parent_id, child_id, profiles:child_id(full_name, username)").eq("parent_id", me));
      for (const l of links) {
        if (l.parent_id !== me || typeof l.child_id !== "string") continue;
        const p = (l.profiles ?? null) as { full_name?: string | null; username?: string | null } | null;
        const label = (p?.full_name || p?.username || "").trim();
        if (label && label.toLowerCase().includes(q)) {
          entities.push({ kind: "learner", id: l.child_id, label, via: "context.resolve" });
          facts.push({ kind: "learner", id: l.child_id, name: label, class: null });
        }
      }
    }
  }
  if (kind === "book" || kind === "any") {
    const books = await rowsOf(deps.session.from("books").select("id, title, owner_id, school_id").ilike("title", `%${query}%`).limit(10));
    for (const b of books) {
      if (typeof b.id !== "string" || typeof b.title !== "string") continue;
      if (!b.title.toLowerCase().includes(query.toLowerCase())) continue; // the ilike, re-checked
      if (!(b.owner_id === me || (!!school && b.school_id === school))) continue;
      entities.push({ kind: "book", id: b.id, label: b.title, via: "context.resolve" });
      facts.push({ kind: "book", id: b.id, title: b.title });
    }
  }

  if (!entities.length) return { ok: true, summary: `No ${kind === "any" ? "class, learner or book" : kind} matches "${query}".`, facts: [], entities: [] };
  const summary = entities
    .slice(0, 8)
    .map((e) => `${e.kind} "${e.label}" (${e.id})`)
    .join("; ");
  return { ok: true, summary: `Found ${entities.length}: ${summary}`, facts, entities };
}

export const resolveCapability: SkCapability = {
  meta: {
    name: "context.resolve",
    description:
      "Look up an entity the user named so other tools can use its id: a class by name (e.g. '7B'), a learner by name in the user's own classes (or a parent's children), or a book by title. Returns matching ids and labels; returns nothing when there is no match — never guess an id.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The name or title as the user said it." },
        kind: { type: "string", enum: ["class", "learner", "book", "any"], description: "Narrow the lookup; default any." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    tier: "immediate",
    kind: "read",
    roles: ["teacher", "parent", "school_admin", "coordinator"],
  },
  handler: resolveEntities,
};
