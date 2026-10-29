// SK Shell — the job tray and the greeting's kit notices (S2 acceptance:
// "lesson prep lands in the job tray and the next greeting").
//
// Both read the SAME thing `lesson.status` reads — prepare.ts `recentKits`
// (her generations with sk_action_id set, grouped by action, the presentation
// heading each group) — and map it through the SAME rule, prepare.ts
// `kitState`. Nothing here decides a kit's state on its own.
//
// - trayKits: at most 3 SK-started kits of the last 7 days, newest first, each
//   with its state and an Open link that `navigate` builds (the Library with
//   the book's row opened: /dashboard?book=…). Read through the user-session
//   client; every row is re-checked in code as hers.
// - kitNotices: for the greeting — kits of the same window that have FINISHED
//   (ready or failed) and were not announced yet, at most 2 lines. Time-boxed:
//   a slow or failing read never holds the greeting; it is skipped and logged.

import type { ResolvedEntity, SkCapabilityDeps, SkContext } from "./types";
import { kitFinished, kitState, recentKits, type KitState, type KitStatus } from "@/sk/capabilities/prepare";
import { resolveNavigate } from "@/sk/capabilities/navigate";
import { allowedFor } from "./registry";
import { lineFor } from "./lines";
import { KIT_FAILED_NOTICE, KIT_READY_NOTICE } from "./act-lines";
import type { SkOffer } from "./memory";

export const KIT_TRAY_DAYS = 7;
export const KIT_TRAY_MAX = 3;
export const KIT_NOTICE_MAX = 2;
export const KIT_NOTICE_TIMEOUT_MS = 1500;

export type TrayKit = {
  /** The kit's presentation generation id. */
  id: string;
  title: string;
  state: KitState;
  ready: number;
  total: number;
  /** The Library location (navigate's own path), or null when her view has none. */
  href: string | null;
};

/** The tray/notice window: kits started in the last KIT_TRAY_DAYS days. */
export const kitWindowStart = (now: Date): string => new Date(now.getTime() - KIT_TRAY_DAYS * 86_400_000).toISOString();

/** The tray and the notices exist where `lesson.status` does (teacher, teacher hat). */
export const kitTrayAllowed = (ctx: SkContext): boolean => allowedFor(ctx).some((c) => c.meta.name === "lesson.status");

/** The Library path for a kit's book, through `navigate` (visibility re-checked). */
export function kitHref(ctx: SkContext, k: Pick<KitStatus, "bookId">): string | null {
  if (!k.bookId) return null;
  const r = resolveNavigate(ctx, { target: "library", bookId: k.bookId });
  return r.ok && r.navigate ? r.navigate.path : null;
}

/** SK-started kits of the window with a presentation row, newest first. */
async function windowKits(ctx: SkContext, deps: SkCapabilityDeps, limit: number): Promise<KitStatus[]> {
  const kits = await recentKits(ctx, deps, limit, { since: kitWindowStart(deps.now), skOnly: true });
  return kits.filter((k) => k.viaSk && !!k.presentationId);
}

export async function trayKits(ctx: SkContext, deps: SkCapabilityDeps): Promise<TrayKit[]> {
  if (!kitTrayAllowed(ctx)) return [];
  const kits = await windowKits(ctx, deps, KIT_TRAY_MAX);
  return kits.slice(0, KIT_TRAY_MAX).map((k) => ({
    id: k.presentationId as string,
    title: k.title,
    state: kitState(k),
    ready: k.done,
    total: k.total,
    href: kitHref(ctx, k),
  }));
}

export type KitNotices = { lines: string[]; ids: string[]; entities: ResolvedEntity[]; offer: SkOffer | null };
export const NO_KIT_NOTICES: KitNotices = { lines: [], ids: [], entities: [], offer: null };

/** Pure: the notices for these kits, given what was already announced. */
export function noticesFor(ctx: SkContext, kits: KitStatus[], announced: readonly string[]): KitNotices {
  const seen = new Set(announced);
  const out: KitNotices = { lines: [], ids: [], entities: [], offer: null };
  for (const k of kits) {
    if (out.ids.length >= KIT_NOTICE_MAX) break;
    const id = k.presentationId;
    if (!id || !k.viaSk || seen.has(id)) continue;
    const state = kitState(k);
    if (!kitFinished(state)) continue;
    seen.add(id);
    out.ids.push(id);
    out.lines.push(lineFor(state === "ready" ? KIT_READY_NOTICE : KIT_FAILED_NOTICE, ctx.user.locale, { chapter: k.title }));
    out.entities.push({ kind: "kit", id, label: k.title, via: "greeting", ids: [k.bookId ?? "", k.chapterRef ?? ""] });
    // "yes" / "open it" opens the FIRST ready kit the greeting offered.
    if (state === "ready" && !out.offer && k.bookId && kitHref(ctx, k)) out.offer = { target: "library", bookId: k.bookId, label: k.title };
  }
  return out;
}

export type KitNoticeOptions = { timeoutMs?: number; log?: (msg: string, detail?: unknown) => void };

/** The greeting's kit notices — never blocks it: past the time box, or on any
 *  error, it answers none and logs server-side. */
export async function kitNotices(ctx: SkContext, deps: SkCapabilityDeps, announced: readonly string[], opts: KitNoticeOptions = {}): Promise<KitNotices> {
  const log = opts.log ?? ((msg: string, detail?: unknown) => console.warn(msg, detail ?? ""));
  if (!kitTrayAllowed(ctx)) return NO_KIT_NOTICES;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? KIT_NOTICE_TIMEOUT_MS);
  });
  try {
    const work = windowKits(ctx, deps, 10).then((kits) => noticesFor(ctx, kits, announced));
    const r = await Promise.race([work, timeout]);
    if (r === "timeout") {
      // The read keeps running; its answer (or error) is dropped.
      work.catch(() => undefined);
      log("sk-shell.greeting kit notices skipped: timeout");
      return NO_KIT_NOTICES;
    }
    return r;
  } catch (e) {
    log("sk-shell.greeting kit notices skipped: error", e instanceof Error ? e.message : String(e));
    return NO_KIT_NOTICES;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
