// Fakes for the S2 action suites. Not a test file (vitest only picks *.test.ts).
//
// - `signedRow`: an sk_action_tokens row + its opaque token, HMAC'd like tokens.ts.
// - `statefulAdmin`: the token table and the two RPCs with 0163/0164's real
//   semantics — `sk_consume_action_token` marks used_at ONCE (a second consume
//   is already_used), `sk_assign_with_token` consumes and records a share write.
//   Reads return a COPY, so two concurrent clicks both pass verification and
//   race on the consume, as they would against Postgres.
// - `diarySession`: a user-session fake whose reads ignore filters (the
//   handlers' own in-code filters are what is tested) and whose diary_notes
//   insert enforces 0169's unique index (sk_action_id, coalesce(student_id,
//   class_id)) → 23505, and can be told to answer an RLS denial (42501).
//   S2 slice B: generations inserts (0169's per-kind index) and status-guarded
//   updates, see the function's own comment.

import { canonicalParams, encodeToken, signToken, type ActionParams, type ActionTokenRow } from "../tokens";
import { NOW, TEACHER_ID } from "./fixtures";

export const ACT_SECRET = "act-s2-secret-of-adequate-length-0001";
export const CLASS_7B = "c7b00000-0000-4000-8000-000000000001";
export const CLASS_7C = "c7c00000-0000-4000-8000-000000000002";
export const FOREIGN_CLASS = "cf000000-0000-4000-8000-000000000003";
export const GEN = "9e000000-0000-4000-8000-000000000004";
export const SHARE = "5a000000-0000-4000-8000-000000000005";
export const ALI = "a1000000-0000-4000-8000-000000000011";
export const SITI = "a2000000-0000-4000-8000-000000000012";
export const AHMAD = "a3000000-0000-4000-8000-000000000013";
export const MEI = "a4000000-0000-4000-8000-000000000014";
export const GONE = "a5000000-0000-4000-8000-000000000015";
// S2 slice B
export const SUB = "5b000000-0000-4000-8000-000000000021";
export const SUB2 = "5b000000-0000-4000-8000-000000000022";
export const BOOK = "b0000000-0000-4000-8000-000000000031";
// S4 slice D: a book product and a parent's two children.
export const PRODUCT = "d0000000-0000-4000-8000-000000000041";
export const AISYAH = "a6000000-0000-4000-8000-000000000016";
export const OMAR = "a7000000-0000-4000-8000-000000000017";

/** S4 slice D: the redeem RPCs' semantics for statefulAdmin — codes by HMAC
 *  (single use), verified parent links (else not_your_child), and a forced
 *  outcome for the mapping tests. */
export type RedeemWorld = {
  codes: Record<string, { used?: boolean; product_id?: string }>;
  links?: Array<{ parent: string; child: string }>;
  force?: string;
  forceError?: boolean;
};

export function signedRow(
  over: Partial<Omit<ActionTokenRow, "hmac">> & { action: string; params: ActionParams; contextHash: string; id?: string },
): { row: ActionTokenRow; token: string } {
  const { contextHash, ...rest } = over;
  const base: Omit<ActionTokenRow, "hmac"> = {
    id: over.id ?? "77777777-7777-4777-8777-777777777777",
    user_id: TEACHER_ID,
    params_canonical: canonicalParams(over.params),
    context_hash: contextHash,
    nonce: "n0nce",
    expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
    used_at: null,
    ...rest,
  } as Omit<ActionTokenRow, "hmac">;
  const hmac = signToken(ACT_SECRET, {
    userId: base.user_id,
    action: base.action,
    canonical: base.params_canonical,
    contextHash: base.context_hash,
    nonce: base.nonce,
    expiresAt: new Date(base.expires_at).toISOString(),
  });
  return { row: { ...base, hmac }, token: encodeToken(base.id, hmac) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function statefulAdmin(rows: Record<string, ActionTokenRow>, now: Date = NOW, redeem?: RedeemWorld) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const shareWrites: string[] = [];
  const grants: Array<{ user: string; child: string | null; product: string }> = [];
  const consume = (id: string, hash: string): string => {
    const r = rows[id];
    if (!r) return "not_found";
    if (r.used_at) return "already_used";
    if (new Date(r.expires_at).getTime() <= now.getTime()) return "expired";
    if (r.context_hash !== hash) return "context_mismatch";
    rows[id] = { ...r, used_at: now.toISOString() };
    return "done";
  };
  return {
    rows,
    calls,
    shareWrites,
    grants,
    from: (table: string) => {
      if (table !== "sk_action_tokens") throw new Error(`admin touched ${table}`);
      return {
        select: () => ({
          eq: (_c: string, id: string) => ({
            maybeSingle: async () => ({ data: rows[id] ? { ...rows[id] } : null, error: null }),
          }),
        }),
      };
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      await Promise.resolve(); // let a concurrent click interleave
      if (fn === "sk_consume_action_token") return { data: consume(String(args.p_token), String(args.p_context_hash)), error: null };
      if (fn === "sk_assign_with_token") {
        const outcome = consume(String(args.p_token), String(args.p_context_hash));
        if (outcome !== "done") return { data: { outcome }, error: null };
        const p = rows[String(args.p_token)].params;
        shareWrites.push(`${p.generation_id}|${p.class_id}`);
        return { data: { outcome: "done", share_id: "s1", class_id: p.class_id, generation_id: p.generation_id, due_at: p.due_at }, error: null };
      }
      if (redeem && (fn === "redeem_book_code" || fn === "redeem_edition_code")) {
        if (redeem.forceError) return { data: null, error: { message: "rpc boom" } };
        if (redeem.force) return { data: { outcome: redeem.force }, error: null };
        const c = redeem.codes[String(args.p_code_hmac)];
        if (!c) return { data: { outcome: "invalid" }, error: null };
        if (c.used) return { data: { outcome: "used" }, error: null };
        const child = (args.p_for_child as string | null) ?? null;
        if (child && !(redeem.links ?? []).some((l) => l.parent === args.p_user && l.child === child)) return { data: { outcome: "not_your_child" }, error: null };
        c.used = true;
        const product = c.product_id ?? PRODUCT;
        grants.push({ user: String(args.p_user), child, product });
        return { data: { outcome: "redeemed", grant: { id: `grant-${grants.length}`, product_id: product, activated_at: now.toISOString(), expires_at: null, tutor_expires_at: "2026-11-27T08:30:00.000Z" } }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  };
}

export type DiarySessionOpts = {
  /** Answer every insert with this error (e.g. {code: "42501"}). */
  insertError?: { code?: string; message?: string };
  /** Answer every update with this error. */
  updateError?: { code?: string; message?: string };
  /** Make reads of this table fail (or answer with this error). */
  failRead?: string;
  readError?: { table: string; error: { code?: string; message?: string } };
};

/**
 * The S2 user-session fake. Reads ignore filters (the handlers' own in-code
 * filters are what is tested). Writes:
 * - diary_notes insert: 0169's unique index (sk_action_id, coalesce(student_id, class_id)) → 23505;
 * - generations insert (S2 slice B): 0169's (sk_action_id, kind, coalesce(params->>'part','1')) → 23505;
 * - school_events insert (S5 slice D): 0171's (sk_action_id) where not null → 23505;
 * - update (S2 slice B): applies the `eq` filters to the table's rows, patches
 *   the matches IN PLACE and returns them — so a status guard really guards.
 */
export function diarySession(tables: Record<string, Array<Record<string, unknown>>>, opts: DiarySessionOpts = {}) {
  const notes: Array<Record<string, unknown>> = [];
  const generations: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: string; patch: Record<string, unknown>; ids: unknown[] }> = [];
  const log: string[] = [];
  let seq = 0;
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    let pendingInsert: Array<Record<string, unknown>> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    const eqs: Array<[string, unknown]> = [];
    let single = false;
    const b: any = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "ilike", "gte", "lte"]) {
      b[m] = (...args: unknown[]) => {
        log.push(`${table}.${m}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        if (m === "eq") eqs.push([String(args[0]), args[1]]);
        return b;
      };
    }
    b.insert = (row: Record<string, unknown> | Array<Record<string, unknown>>) => {
      pendingInsert = Array.isArray(row) ? row : [row];
      log.push(`${table}.insert(${pendingInsert.length})`);
      return b;
    };
    b.update = (patch: Record<string, unknown>) => {
      pendingUpdate = patch;
      log.push(`${table}.update(${JSON.stringify(patch)})`);
      return b;
    };
    b.single = () => {
      single = true;
      return b;
    };
    b.maybeSingle = b.single;
    const run = () => {
      if (pendingUpdate) {
        if (opts.updateError) return { data: null, error: opts.updateError };
        const hit = rows.filter((r) => eqs.every(([c, v]) => r[c] === v));
        for (const r of hit) Object.assign(r, pendingUpdate);
        updates.push({ table, patch: pendingUpdate, ids: hit.map((r) => r.id) });
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      if (pendingInsert) {
        if (opts.insertError) return { data: null, error: opts.insertError };
        if (table === "generations") {
          const key = (r: Record<string, unknown>) => `${r.sk_action_id}|${r.kind}|${(r.params as Record<string, unknown> | null)?.part ?? "1"}`;
          const keys = new Set(generations.filter((g) => g.sk_action_id).map(key));
          for (const r of pendingInsert) {
            if (r.sk_action_id && keys.has(key(r))) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "generations_sk_action_kind_part_uidx"' } };
            keys.add(key(r));
          }
          const out: Array<Record<string, unknown>> = pendingInsert.map((r) => ({ ...r, id: `gen-${++seq}` }));
          generations.push(...out);
          return { data: out.map((o) => ({ id: o.id, kind: o.kind })), error: null };
        }
        if (table === "school_events") {
          const ids = new Set(events.map((e) => e.sk_action_id).filter(Boolean));
          for (const r of pendingInsert) {
            if (r.sk_action_id && ids.has(r.sk_action_id)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "school_events_sk_action_uidx"' } };
            ids.add(r.sk_action_id);
          }
          const out: Array<Record<string, unknown>> = pendingInsert.map((r) => ({ ...r, id: `event-${++seq}` }));
          events.push(...out);
          return { data: single ? { id: out[0].id } : out.map((o) => ({ id: o.id })), error: null };
        }
        if (table !== "diary_notes") return { data: null, error: { message: `insert into ${table}` } };
        const keys = new Set(notes.filter((n) => n.sk_action_id).map((n) => `${n.sk_action_id}|${n.student_id ?? n.class_id}`));
        for (const r of pendingInsert) {
          const k = `${r.sk_action_id}|${r.student_id ?? r.class_id}`;
          if (r.sk_action_id && keys.has(k)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"diary_notes_sk_action_target_uidx\"" } };
          keys.add(k);
        }
        const out: Array<Record<string, unknown>> = pendingInsert.map((r) => ({ ...r, id: `note-${++seq}` }));
        notes.push(...out);
        return { data: single ? { id: out[0].id } : out.map((o) => ({ id: o.id, student_id: o.student_id })), error: null };
      }
      if (opts.failRead === table) return { data: null, error: { message: `${table} read failed` } };
      if (opts.readError?.table === table) return { data: null, error: opts.readError.error };
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
    return b;
  };
  return {
    notes,
    generations,
    events,
    updates,
    log,
    from,
    rpc: async () => ({ data: null, error: null }),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
