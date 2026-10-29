import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({}) }));
import { refuseWaiver } from "@/utils/books/waivers";
import { waivable, type Gap } from "@/utils/books/gaps";

const T = "db78e489-0222-4a18-ad6d-16d213958398";
const gap = (over: Partial<Gap>): Gap => ({
  title: "Graphs", topic_id: T, topic_slug: "graphs", topic_status: null, chapter: 9, chapter_title: null, node_codes: null, role: null,
  state: "kit_or_publication_incomplete", failing: ["B6/en"], steps: [], ...over,
});

describe("readiness waivers", () => {
  it("refuses a missing topic, an unknown check, a missing reason and a duplicate", () => {
    const ok = { topicId: T, check: "B6", reason: "the v1 kit still teaches the topic" };
    expect(refuseWaiver(ok, [], "en", "stale_article")).toBeNull();
    expect(refuseWaiver({ ...ok, topicId: "proposed:x" }, [], "en", null)).toMatch(/exists in the catalogue/);
    expect(refuseWaiver({ ...ok, check: "B1" }, [], "en", null)).toMatch(/missing topic/);
    expect(refuseWaiver({ ...ok, check: "B99" }, [], "en", null)).toMatch(/Unknown check/);
    expect(refuseWaiver({ ...ok, reason: "ok" }, [], "en", null)).toMatch(/why/);
    const active = [{ topic_id: T, check_code: "B6", language: "en", sub_status: "stale_article" }];
    expect(refuseWaiver(ok, active, "en", "stale_article")).toMatch(/already waived/);
    expect(refuseWaiver(ok, active, "en", null)).toBeNull(); // a broader waiver is a different decision
  });

  it("offers every failing check but a missing topic, with the audit's reason when the run has it", () => {
    expect(waivable(gap({}))).toEqual([{ code: "B6", language: "en", verdict: "fail", sub_status: null, detail: null }]);
    const withChecks = gap({ checks: [
      { code: "B6", language: "en", verdict: "fail", sub_status: "stale_article", detail: "current kit was built from another article version" },
      { code: "B7", language: "en", verdict: "warn", sub_status: null, detail: "waived" },
    ] });
    expect(waivable(withChecks).map((c) => [c.code, c.sub_status])).toEqual([["B6", "stale_article"]]);
    expect(waivable(gap({ topic_id: null, failing: ["B1"] }))).toEqual([]);
  });
});
