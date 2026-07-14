import { LogoMark } from "../dashboard/icons";
import SchoolFinder from "./school-finder";

// The school-portal root (served at school.sketchcast.app/ via the proxy
// rewrite): schools are addressed by slug, so all this page does is send the
// visitor to /{slug}. No tenant data is rendered here.
export default function SchoolPortalRootPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          Find your school&apos;s portal — enter the school code from your welcome pack.
        </p>
        <SchoolFinder />
      </div>
    </main>
  );
}
