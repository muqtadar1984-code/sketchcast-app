import { redirect } from "next/navigation";

// Feedback moved into the platform console. This stub keeps the old URL (used
// in founder notification emails) working; the console layout re-guards, so a
// non-staff visitor simply lands back on their dashboard.
export default function BetaFeedbackRedirect() {
  redirect("/console/feedback");
}
