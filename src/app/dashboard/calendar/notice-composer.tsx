import NoticeComposerForm, { RevokeNoticeButtonForm } from "./notice-composer-client";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// The SERVER shells for the notices-publishing pair. Each resolves the
// request's language and hands its control the words it renders — the
// dictionary is server-only, so the strings cross the boundary and the file
// never does. resolveLocale is React-cached per request, so asking here costs
// nothing beyond what the layout already paid. The interactive halves live in
// ./notice-composer-client.tsx.
//
// Gate the render at the CALL SITE; these assume they are allowed to be on
// screen. NoticeComposer's one call site is dashboard/calendar/page.tsx, which
// shows it to the school_admin and to coordinators — coordinators being the
// people HOLDING coordinator_scope rows, not the ones whose profiles.role
// happens to say "coordinator" (a real coordinator's role reads "teacher").
// RevokeNoticeButton's is the school-admin review block. RLS
// (se_admin_write / se_coordinator_write) remains the actual authority; these
// gates only keep a card off screens that could never use it.

export default async function NoticeComposer() {
  const dict = await getDictionary(await resolveLocale());
  return (
    <NoticeComposerForm
      t={{ ...dict.comms.notices.composer, kinds: dict.comms.calendar.kinds, cancel: dict.common.cancel }}
    />
  );
}

export async function RevokeNoticeButton({ eventId, title }: { eventId: string; title: string }) {
  const dict = await getDictionary(await resolveLocale());
  return (
    <RevokeNoticeButtonForm
      eventId={eventId}
      title={title}
      t={{ ...dict.comms.notices.revoke, cancel: dict.common.cancel }}
    />
  );
}
