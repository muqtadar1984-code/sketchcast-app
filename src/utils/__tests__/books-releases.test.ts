import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({}) }));
import { releaseState } from "@/utils/books/releases";

describe("book releases", () => {
  it("names a release's state", () => {
    expect(releaseState({ superseded_by: null, withdrawn_at: null })).toBe("live");
    expect(releaseState({ superseded_by: 7, withdrawn_at: null })).toBe("superseded");
    expect(releaseState({ superseded_by: 7, withdrawn_at: "2026-10-30" })).toBe("withdrawn");
  });
});
