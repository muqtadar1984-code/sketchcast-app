import Link from "next/link";
import { notFound } from "next/navigation";
import { LogoMark } from "../../dashboard/icons";
import { resolveTenant, tenantBasePath } from "./tenant";

export const dynamic = "force-dynamic";

// A school's landing page: {portal}/{slug} → pick your role, then sign in.
// Everything tenant-specific on this screen comes from the server-resolved
// school row (0042); the existing dashboards behind the logins are shared code,
// scoped to the tenant by school_id + RLS.
const ROLES: { role: string; title: string; blurb: string }[] = [
  { role: "principal", title: "Principal", blurb: "Whole-school oversight: at-risk worklist, teachers, access" },
  { role: "teacher", title: "Teacher", blurb: "Library, lessons, assignments, grading and class analytics" },
  { role: "student", title: "Student", blurb: "Your lessons, quizzes and worksheets — sign in with your student ID" },
  { role: "parent", title: "Parent", blurb: "Follow your child's progress and print practice papers" },
];

export default async function SchoolLandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await resolveTenant(slug);
  if (!tenant) notFound();
  const base = await tenantBasePath(tenant.slug);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2.5 mb-1 justify-center">
          <LogoMark size={34} />
          <span className="text-xl font-display">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </span>
        </div>
        <h1 className="text-3xl text-center mt-4">{tenant.displayName}</h1>
        <p className="text-sm text-[#5B6470] text-center mt-2 mb-8">Choose how you sign in</p>

        <div className="grid gap-4 sm:grid-cols-2">
          {ROLES.map((r) => (
            <Link
              key={r.role}
              href={`${base}/${r.role}`}
              className="card rounded-2xl p-6 block hover:shadow-md transition-shadow"
            >
              <h2 className="text-lg text-[#14181F]">{r.title}</h2>
              <p className="text-sm text-[#5B6470] mt-1">{r.blurb}</p>
            </Link>
          ))}
        </div>

        <p className="text-xs text-[#98A0A9] mt-8 text-center">
          {tenant.displayName} runs on SketchCast AI — each school&apos;s space is private to that school.
        </p>
      </div>
    </main>
  );
}
