import ReportIssueForm from "./report-issue-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";

// The floating "Report a problem" widget. This file is a thin SERVER component
// whose only job is to resolve the request's dictionary and hand the words to
// the client form (./report-issue-form) — the same split app-header uses for its
// controls, done here rather than at the call sites because the widget is
// mounted from several dashboards and none of them should have to know its copy.
//
// resolveLocale() is React-cached per request, so asking again costs nothing
// beyond what the page's header already paid.
export default async function ReportIssueWidget({ variant = "adult" }: { variant?: "adult" | "student" }) {
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  return <ReportIssueForm variant={variant} t={t.app.reportIssue} common={t.common} />;
}
