// Pure derivations for the console's school views (0100, Phase 2). Mirrors the
// SCHOOL branches of plan_tier() so the console can never disagree with the
// enforcer about what state a school is in — and keeps that logic testable
// without a database. Nothing here renders prose: the pages word it.

export type SchoolLifecycle = "suspended" | "paid" | "trial" | "expired" | "legacy";

export type SchoolState = { status: string; trial_ends_at: string | null };
export type EntitlementRow = { active: boolean; plan_key: string | null; current_period_end: string | null };

/** plan_tier() order, school branches only: suspended > paid > trial > expired
 * > legacy (no clock — every school that predates 0100). A member's OWN paid
 * plan sits between paid and trial in plan_tier(), but that is a per-member
 * fact, not a school state, so it has no place here. */
export function schoolLifecycle(s: SchoolState, ents: EntitlementRow[], now: Date): SchoolLifecycle {
  if (s.status !== "active") return "suspended";
  const paid = ents.some(
    (e) =>
      e.active &&
      (e.plan_key ?? "").startsWith("school") &&
      (!e.current_period_end || new Date(e.current_period_end).getTime() > now.getTime()),
  );
  if (paid) return "paid";
  if (s.trial_ends_at) return new Date(s.trial_ends_at).getTime() > now.getTime() ? "trial" : "expired";
  return "legacy";
}

/** Whole days until `iso` (rounded up), negative once past; null with no clock. */
export function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - now.getTime()) / 86400000);
}

/** Consumer mailboxes say nothing about the organisation, so a shared domain
 * among these is not a "same school?" signal. Schools DO register with them,
 * so they are never blocked — only excluded from the domain flag. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "ymail.com",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "mail.com", "gmx.com", "gmx.de",
  "proton.me", "protonmail.com", "zoho.com", "yandex.com", "qq.com", "163.com", "126.com",
]);

export type DupInput = {
  id: string;
  email_domain: string | null;
  name_key: string | null;
  reg_ip: string | null;
  created_at: string;
};
export type DupFlag = { kind: "domain" | "name" | "ip"; with: string };

/** Pairwise "probably the same organisation / same person" flags, keyed by
 * school id. Flags, never blocks: a second registration from a real school's
 * domain is a lead to merge, not junk to refuse. The IP flag only counts two
 * registrations within `ipWindowDays` of each other — shared NAT at a school
 * is normal across months, suspicious across an afternoon. */
export function duplicateFlags(rows: DupInput[], ipWindowDays = 30): Map<string, DupFlag[]> {
  const out = new Map<string, DupFlag[]>();
  const push = (id: string, f: DupFlag) => {
    const list = out.get(id) ?? [];
    list.push(f);
    out.set(id, list);
  };
  const windowMs = ipWindowDays * 86400000;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.email_domain && a.email_domain === b.email_domain && !FREE_MAIL_DOMAINS.has(a.email_domain)) {
        push(a.id, { kind: "domain", with: b.id });
        push(b.id, { kind: "domain", with: a.id });
      }
      if (a.name_key && a.name_key === b.name_key) {
        push(a.id, { kind: "name", with: b.id });
        push(b.id, { kind: "name", with: a.id });
      }
      if (a.reg_ip && a.reg_ip === b.reg_ip) {
        const gap = Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        if (gap <= windowMs) {
          push(a.id, { kind: "ip", with: b.id });
          push(b.id, { kind: "ip", with: a.id });
        }
      }
    }
  }
  return out;
}

const RANK: Record<SchoolLifecycle, number> = { trial: 0, expired: 1, paid: 2, legacy: 3, suspended: 4 };

/** The registrations view's default order — the hot/cold signal without a
 * scoring model: live trials first, soonest-ending on top; then expired
 * (follow-ups), paid, legacy, suspended; newest first within a group. */
export function sortSchools<T extends { lifecycle: SchoolLifecycle; trial_ends_at: string | null; created_at: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const r = RANK[a.lifecycle] - RANK[b.lifecycle];
    if (r !== 0) return r;
    if (a.lifecycle === "trial" && a.trial_ends_at && b.trial_ends_at) {
      const t = new Date(a.trial_ends_at).getTime() - new Date(b.trial_ends_at).getTime();
      if (t !== 0) return t;
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}
