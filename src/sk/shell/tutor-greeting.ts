// SK S3 slice D — the student's greeting on /sk (Final Plan §4.6: one
// contextual line, only when a tool supports it). Server only.
//
//   1. On a kit's page (the panel sends the kit player's state): "Hi Aisha —
//      you were on Red blood cells of Specialised Cells. Carry on?" — the kit
//      opened through the kit routes' own checks (tutor.ts loadTutorKit), the
//      section named from the kit map, never from the client's text.
//   2. Elsewhere on /sk: the kit she last answered a question in (her own kit
//      session), at the section of her latest answer.
//   3. Else her kit chapters: "Hi Aisha — here are your chapters: …".
//   4. Else SK introduces itself.
// "Carry on?" leaves a one-turn offer in the memory blob: a yes plays the
// section on the kit's page, or opens the kit's chapter from anywhere else.
// Every read is time-boxed; a slow or failed one falls through to the next.

import type { KitDeps } from "@/sk/kit-server";
import { kitDeps } from "@/sk/kit-server";
import { practiseItemIds } from "@/sk/kit-view";
import { findKitChapter, lastKitSession, loadTutorKit, readKitAttempts, studentChapters, visibleProducts, type TutorKit } from "@/sk/tutor";
import { lineFor } from "./lines";
import type { SkOffer } from "./memory";
import { TUTOR_CHAPTER, TUTOR_GREETING_LIST, TUTOR_GREETING_NONE, TUTOR_GREETING_RESUME, TUTOR_SECTION_N } from "./tutor-lines";
import type { SkContext, SkSessionDb } from "./types";

export const TUTOR_GREETING_TIMEOUT_MS = 2500;
const LIST_MAX = 6;

export type TutorGreeting = { text: string; offer: SkOffer | null };

/** Her first name: profiles.full_name, else username, else the address's local part. */
export async function firstName(session: SkSessionDb, ctx: SkContext): Promise<string> {
  try {
    const { data } = (await session.from("profiles").select("id, full_name, username").eq("id", ctx.user.id).maybeSingle()) as { data: Record<string, unknown> | null };
    const full = typeof data?.full_name === "string" ? data.full_name.trim() : "";
    if (full) return full.split(/\s+/)[0]!.slice(0, 40);
    const user = typeof data?.username === "string" ? data.username.trim() : "";
    if (user) return user.slice(0, 40);
  } catch {
    /* fall through */
  }
  return (ctx.user.email ?? "").split("@")[0]!.slice(0, 40);
}

function resume(ctx: SkContext, name: string, kit: TutorKit, index: number): TutorGreeting {
  const s = kit.sections[index] ?? kit.sections[0];
  const section = s?.heading || lineFor(TUTOR_SECTION_N, ctx.user.locale, { n: (s?.index ?? 0) + 1 });
  return {
    text: lineFor(TUTOR_GREETING_RESUME, ctx.user.locale, { name, section, kit: kit.title }),
    offer: { target: "tutor", product: kit.product, chapter: kit.chapter, kit: kit.generationId, label: kit.title.slice(0, 160) },
  };
}

async function build(ctx: SkContext, session: SkSessionDb, deps: KitDeps): Promise<TutorGreeting> {
  const name = await firstName(session, ctx);
  const t = ctx.tutor;
  if (t?.kit) {
    const loaded = await loadTutorKit(ctx.user.id, { product: t.product, chapter: t.chapter, kit: t.kit }, deps);
    if (loaded.ok) return resume(ctx, name, loaded.kit, t.k ?? 0);
  }
  const products = await visibleProducts(session);
  const last = await lastKitSession(session, ctx.user.id);
  if (last) {
    const where = await findKitChapter(ctx.user.id, products, last.generationId, deps);
    if (where) {
      const loaded = await loadTutorKit(ctx.user.id, { product: where.product, chapter: where.chapter, kit: last.generationId }, deps);
      if (loaded.ok) {
        const attempts = await readKitAttempts(session, ctx.user.id, last.generationId);
        const lastItem = attempts[attempts.length - 1]?.itemId;
        const at = lastItem ? loaded.kit.sections.findIndex((s) => practiseItemIds(loaded.kit.manifest, s.key).includes(lastItem)) : -1;
        return resume(ctx, name, loaded.kit, Math.max(0, at));
      }
    }
  }
  const chapters = await studentChapters(ctx.user.id, products, deps, LIST_MAX);
  if (chapters.length) {
    const list = chapters.map((c) => `${lineFor(TUTOR_CHAPTER, ctx.user.locale, { n: c.chapterRef })}: ${c.title}`).join("; ");
    return { text: lineFor(TUTOR_GREETING_LIST, ctx.user.locale, { name, list }), offer: null };
  }
  return { text: lineFor(TUTOR_GREETING_NONE, ctx.user.locale, { name }), offer: null };
}

/** The greeting, never slower than the time box and never throwing. */
export async function tutorGreeting(ctx: SkContext, session: SkSessionDb, opts: { deps?: KitDeps; timeoutMs?: number } = {}): Promise<TutorGreeting> {
  const fallback = async (): Promise<TutorGreeting> => ({ text: lineFor(TUTOR_GREETING_NONE, ctx.user.locale, { name: await firstName(session, ctx).catch(() => "") }), offer: null });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const deps = opts.deps ?? kitDeps();
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? TUTOR_GREETING_TIMEOUT_MS);
    });
    const g = await Promise.race([build(ctx, session, deps), slow]);
    return g ?? (await fallback());
  } catch (e) {
    console.error("[sk] tutor greeting:", (e as Error).message);
    return fallback();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
