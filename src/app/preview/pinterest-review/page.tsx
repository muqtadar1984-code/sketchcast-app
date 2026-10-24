import { notFound } from "next/navigation";
import type { PinView } from "@/utils/catalogue/pinterest";
import { PinterestHeading, PinterestNav } from "@/app/library/pinterest/chrome";
import { ReviewTable } from "@/app/library/pinterest/review-table";

// Dev-only gallery for the Pinterest review table (/preview/pinterest-review):
// the real component with fixture pins, so its layout can be checked without
// a Library login or production data. notFound() in production, like the
// other /preview pages. The actions POST to the real route and fail here
// without a session — this page is for looking, not acting.

const card = (title: string, band: string, tone: string) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500"><rect width="1000" height="1500" fill="#fff"/>` +
      `<rect width="1000" height="180" fill="${tone}"/><text x="60" y="115" font-size="64" font-family="sans-serif" font-weight="bold" fill="#fff">${title}</text>` +
      `<text x="60" y="270" font-size="44" font-family="sans-serif" font-weight="bold" fill="#14241E">${band}</text>` +
      `<rect x="60" y="420" width="880" height="560" fill="#F4F5F2" stroke="#D9DDD5"/><rect y="1350" width="1000" height="150" fill="#1C3A5A"/>` +
      `<text x="140" y="1440" font-size="44" font-family="sans-serif" fill="#fff">sketchcast.app</text></svg>`,
  );

const base = {
  source_kind: "preview", source_ref: "x", kit_id: null, format: "static" as const, board_id: "b1", grade_band: "8",
  utm: {}, back_translation: null, ai_modified: false, edited: false, reject_reason: null, approved_by: null, approved_at: null,
  round_id: null, pinterest_pin_id: null, posted_at: null, attempts: 0, last_error: null, updated_at: "2026-10-24T07:20:00Z",
  boardName: "Free Science & Maths Worksheets", language: "en",
  precheck: { blocking: [], warnings: [], checked_at: "2026-10-24T07:18:00Z" },
};

const FIXTURES: PinView[] = [
  { ...base, id: "p1", topic_id: "t1", topicTitle: "A Balanced Diet", template: "worksheet", status: "in_review",
    title: "Balanced Diet Worksheet: Nutrients and Their Functions for Class 6",
    description: "This free balanced diet worksheet gives teachers and parents a ready-to-print page for a Class 6 science lesson on the six main constituents of a balanced diet.",
    alt_text: "Worksheet card with a title band reading 'A Balanced Diet' and a preview of page 1 of the worksheet.",
    link: "https://sketchcast.app/topics/a-balanced-diet?utm_source=pinterest&utm_medium=organic&utm_campaign=pin_engine",
    images: [{ path: "a" }], imageUrls: [card("A Balanced Diet", "FREE WORKSHEET", "#263238")], created_at: "2026-10-24T07:18:00Z" },
  { ...base, id: "p2", topic_id: "t2", topicTitle: "Reactivity of Metals", template: "worksheet", status: "in_review",
    title: "Free Reactivity of Metals Worksheet for Science Class",
    description: "A free reactivity series worksheet for middle school chemistry.", alt_text: "Worksheet card for Reactivity of Metals.",
    link: "https://sketchcast.app/topics/reactivity-of-metals", images: [{ path: "b" }],
    imageUrls: [card("Reactivity of Metals", "FREE WORKSHEET", "#3E2723")], created_at: "2026-10-24T07:17:00Z" },
  { ...base, id: "p3", topic_id: "t3", topicTitle: "Cells", template: "explainer", status: "in_review", boardName: "Biology Diagrams & Worksheets",
    title: "Plant and Animal Cells: 4 Key Differences for Class 7",
    description: "A clear explainer on plant and animal cells.", alt_text: "Explainer card listing four differences.",
    link: "https://sketchcast.app/topics/cells", images: [{ path: "c" }], imageUrls: [card("Plant vs Animal Cells", "4 KEY POINTS", "#1B5E20")],
    precheck: { blocking: [], warnings: [], checked_at: undefined }, edited: true, created_at: "2026-10-24T07:19:00Z" },
  { ...base, id: "p4", topic_id: "t4", topicTitle: "Inheritance and Variation", template: "worksheet", status: "approved",
    title: "Free Inheritance and Variation Worksheet for Class 10 Biology", description: "…", alt_text: "Worksheet card.",
    link: "https://sketchcast.app/topics/inheritance-and-variation", images: [{ path: "d" }],
    imageUrls: [card("Inheritance and Variation", "FREE WORKSHEET", "#4A148C")], approved_by: "u", approved_at: "2026-10-24T07:31:00Z",
    created_at: "2026-10-24T07:16:00Z" },
  { ...base, id: "p5", topic_id: "t5", topicTitle: "Weather and Climate", template: "diagram", status: "rejected",
    title: "Weather vs Climate: A Diagram for Revision", description: "…", alt_text: "Diagram card.",
    link: "https://sketchcast.app/topics/weather-and-climate", images: [{ path: "e" }],
    imageUrls: [card("Weather vs Climate", "DIAGRAM", "#0D47A1")], reject_reason: "Legend overlaps the picture", created_at: "2026-10-24T07:10:00Z" },
  { ...base, id: "p6", topic_id: "t6", topicTitle: "Quadratic Expressions", template: "explainer", status: "failed",
    title: null, description: null, alt_text: null, link: null, images: [], imageUrls: [],
    last_error: "copy: the reply has no 'pins' list", created_at: "2026-10-24T06:02:00Z" },
];

export default function PinterestReviewPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <PinterestHeading settings={{ enabled: true, dry_run: true }} />
      <PinterestNav active="review" counts={{ in_review: 3, approved: 1 }} />
      <ReviewTable pins={FIXTURES} canAct />
    </main>
  );
}
