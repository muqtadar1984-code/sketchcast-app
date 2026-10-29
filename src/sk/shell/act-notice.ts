// SK Shell — executing `notice.school` (S5 slice D) from a VERIFIED token row.
//
// CLICK-ONLY (§9.2: school-wide notices): act.ts refuses a spoken yes before
// this runs — the handler carries clickOnly and the name is in CLICK_ONLY.
//
// Follows act-core's `consumeThenWrite`, like diary.note:
//   1. the stored params are shape-checked and run through the SAME builder
//      POST /api/notices uses (utils/notice-row.ts validateNotice) — a bad or
//      stale row is refused BEFORE the consume (nothing burned);
//   2. the token is consumed through the admin RPC (single use);
//   3. the school_events row (is_notice = true) is inserted AS THE LEADER
//      through the user-session client, built by buildNoticeRow with
//      sk_action_id = token id. 0068's se_admin_write / se_coordinator_write
//      decide standing (42501 → refused); 0171's unique index makes a repeat
//      write fail (23505 → "That was already done.").
// The school is the leader's own (ctx.user.schoolId, the profile's), exactly
// as the route takes it — never a param.

import type { SkSessionDb } from "./types";
import type { ActionTokenRow } from "./tokens";
import { consumeThenWrite, fail, failedStage, str, writeFailure, type ActInput, type Handled, type WriteOutcome } from "./act-core";
import { lineFor } from "./lines";
import { ACT_WRITE_FAILED } from "./act-lines";
import { NOTICE_DATE_PASSED, NOTICE_OFF, NOTICE_POSTED_SCHOOL, NOTICE_POSTED_STAFF } from "./act-notice-lines";
import { NOTICE_AUDIENCES, buildNoticeRow, schoolDayInstant, validateNotice, type NoticeAudience } from "@/utils/notice-row";
import { isRealDay } from "@/sk/capabilities/diary";
import { noticesOn } from "@/sk/capabilities/notice";

const badParams = (reason = "bad_params") => fail("refused", undefined, { reason });

export async function runNoticeSchool(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const p = row.params ?? {};
  const { ctx } = input;
  const locale = ctx.user.locale;
  const audience = NOTICE_AUDIENCES.find((a) => a === p.audience) as NoticeAudience | undefined;
  const title = str(p.title).trim();
  const body = str(p.body).trim();
  const day = str(p.starts_at);
  if (!audience || !title || !body || !isRealDay(day) || p.click_only !== true) return badParams();
  if (!noticesOn()) return fail("refused", lineFor(NOTICE_OFF, locale), { reason: "notices_off" });
  const schoolId = ctx.user.schoolId;
  if (!schoolId) return fail("refused", undefined, { reason: "no_school" });

  // The composer's own rules, at execution time (a card made late last night
  // and clicked this morning is refused here, before anything is consumed).
  const v = validateNotice({ title, body, audience, startsAt: schoolDayInstant(day) }, input.now.getTime());
  if (!v.ok) return v.code === "dates_passed" ? fail("refused", lineFor(NOTICE_DATE_PASSED, locale), { reason: v.code }) : badParams(v.code);
  if (!input.session) return fail("error", undefined, undefined, "error:no_session");

  const r = await consumeThenWrite(input.admin, input.session, row, ctx, async (db: SkSessionDb, actionId: string): Promise<WriteOutcome<{ id: string }>> => {
    const res = (await db
      .from("school_events")
      .insert(buildNoticeRow(v.fields, { schoolId, createdBy: ctx.user.id, skActionId: actionId, allDay: true }))
      .select("id")
      .single()) as { data?: { id?: string } | null; error?: unknown };
    if (res?.error || !res?.data?.id) return writeFailure(res?.error);
    return { ok: true, value: { id: String(res.data.id) } };
  });
  const failed = failedStage(r, lineFor(ACT_WRITE_FAILED, locale));
  if (failed) return failed;
  const noticeId = r.stage === "write" && r.result.ok ? r.result.value.id : null;
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: lineFor(audience === "staff" ? NOTICE_POSTED_STAFF : NOTICE_POSTED_SCHOOL, locale, { title }),
      result: { notice_id: noticeId, audience, starts_at: day },
    },
    entities: [],
  };
}
