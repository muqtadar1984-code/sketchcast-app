import AssistantLauncher from "./assistant-launcher";

// Mount the floating AI Teaching Assistant ONCE for every dashboard surface —
// student, teacher, parent, coordinator, principal — so it rides along on the
// children / school / analytics / test-papers sub-pages too, not just the main
// dashboard. It self-hides when NEXT_PUBLIC_FEATURE_AI_ASSISTANT is off, and
// /api/assistant is the authoritative server gate.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AssistantLauncher />
    </>
  );
}
