import BetaNotice from "./beta-notice";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// The beta-welcome banner. A thin SERVER component: it resolves the request's
// dictionary and hands the words to the client half (./beta-notice), which owns
// the localStorage dismissal. Kept at this filename so the Library page mounts
// it exactly as before.
export default async function BetaBanner() {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  return <BetaNotice t={t.app.betaBanner} dismissLabel={t.common.close} />;
}
