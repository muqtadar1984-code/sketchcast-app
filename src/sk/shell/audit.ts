// SK Shell — the audit sink (Final Plan §2.5, §8.2). Every capability run
// writes one SkActionRow (ok or not, with its duration). The row mirrors the
// 0162 `sk_actions` columns exactly; the DB sink is used only when SK_AUDIT=db
// (the table is not in production yet — 0162 ships with PR #156, unapplied).
// A sink failure NEVER fails the turn.

import type { SkActionRow } from "./types";

export interface SkAuditSink {
  record(row: SkActionRow): void | Promise<void>;
}

/** The default: a bounded in-process buffer (inspectable in tests and logs). */
export class MemoryAuditSink implements SkAuditSink {
  readonly rows: SkActionRow[] = [];
  constructor(private readonly cap = 500) {}
  record(row: SkActionRow): void {
    this.rows.push(row);
    if (this.rows.length > this.cap) this.rows.splice(0, this.rows.length - this.cap);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuditAdmin = { from: (table: string) => any };

/** Service-role insert into sk_actions. Errors are logged, never thrown. */
export class DbAuditSink implements SkAuditSink {
  constructor(private readonly admin: AuditAdmin) {}
  async record(row: SkActionRow): Promise<void> {
    try {
      const { error } = await this.admin.from("sk_actions").insert(row);
      if (error) console.warn("sk-shell: audit insert failed", (error as { message?: string }).message ?? error);
    } catch (e) {
      console.warn("sk-shell: audit insert threw", (e as Error).message);
    }
  }
}

const shared = new MemoryAuditSink();

/** The sink for this deployment: DB when SK_AUDIT=db and an admin client is
 *  available, else the shared memory buffer. */
export function auditSinkFor(admin: AuditAdmin | null | undefined): SkAuditSink {
  if (process.env.SK_AUDIT === "db" && admin) return new DbAuditSink(admin);
  return shared;
}

/** Fire-and-forget write that swallows every failure (the turn goes on). */
export function recordSafely(sink: SkAuditSink, row: SkActionRow): Promise<void> {
  try {
    return Promise.resolve(sink.record(row)).catch((e) => {
      console.warn("sk-shell: audit sink rejected", (e as Error)?.message);
    });
  } catch (e) {
    console.warn("sk-shell: audit sink threw", (e as Error)?.message);
    return Promise.resolve();
  }
}
