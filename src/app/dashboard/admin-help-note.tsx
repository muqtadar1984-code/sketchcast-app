// A quiet "reach out to us" note for the Principal, Teacher and Coordinator
// surfaces (founder 2026-07-20): password resets and adding students are
// self-serve; anything else in the way of school admin, SketchCast staff handle.
// Static — no client JS.
export default function AdminHelpNote() {
  return (
    <div className="rounded-xl border border-[#E6E8E4] bg-white px-5 py-3 text-sm text-[#5B6470] flex flex-wrap items-center gap-x-2 gap-y-1">
      <span aria-hidden>✉️</span>
      <span>
        Need help with school admin? You can reset passwords and add students yourself. For anything
        else, email the SketchCast team at{" "}
        <a href="mailto:hello@sketchcast.app" className="font-medium text-[#0C8175] hover:underline">
          hello@sketchcast.app
        </a>
        .
      </span>
    </div>
  );
}
