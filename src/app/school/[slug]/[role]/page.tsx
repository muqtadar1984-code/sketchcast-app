import Link from "next/link";
import { notFound } from "next/navigation";
import { LogoMark } from "../../../dashboard/icons";
import { isPortalRole, type PortalRole } from "@/utils/school-routing";
import { resolveTenant, tenantBasePath } from "../tenant";
import PortalLogin from "./portal-login";

export const dynamic = "force-dynamic";

// Role-scoped login: {portal}/{slug}/{principal|teacher|student|parent}.
// The role picks the copy and the post-login home; the slug is verified
// SERVER-SIDE after sign-in (/api/school-portal/verify) so an account from a
// different school is signed straight back out. RLS remains the data guard.
const COPY: Record<PortalRole, { title: string; hint: string }> = {
  principal: { title: "Principal sign in", hint: "Use your school-leadership email." },
  teacher: { title: "Teacher sign in", hint: "Use your teacher email." },
  student: { title: "Student sign in", hint: "Use the student ID your teacher gave you." },
  parent: { title: "Parent sign in", hint: "Use the parent email your school registered." },
};

export default async function PortalRolePage({ params }: { params: Promise<{ slug: string; role: string }> }) {
  const { slug, role } = await params;
  if (!isPortalRole(role)) notFound();
  const tenant = await resolveTenant(slug);
  if (!tenant) notFound();
  const base = await tenantBasePath(tenant.slug);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#14181F] mt-3 font-medium">{tenant.displayName}</p>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          {COPY[role].title} — {COPY[role].hint}
        </p>

        <PortalLogin slug={tenant.slug} role={role} />

        <p className="text-xs text-[#98A0A9] mt-6 text-center">
          Wrong door?{" "}
          <Link href={base} className="text-[#0C8175] hover:underline">
            Back to {tenant.displayName}
          </Link>
        </p>
      </div>
    </main>
  );
}
