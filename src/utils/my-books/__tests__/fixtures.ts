// Shared rows for the My books tests (SK S7 K3).
import type { MyBookGrant, MyBookProduct, MyBookRelease } from "../decide";

export const NOW = new Date("2026-11-01T00:00:00Z");
export const ME = "11111111-1111-1111-1111-111111111111";
export const KID = "22222222-2222-2222-2222-222222222222";
export const STRANGER_KID = "33333333-3333-3333-3333-333333333333";

export const P_BIO = "aaaaaaaa-0000-0000-0000-000000000001"; // live final
export const P_ALG = "aaaaaaaa-0000-0000-0000-000000000002"; // live final, granted to the child
export const P_OLD = "aaaaaaaa-0000-0000-0000-000000000003"; // withdrawn
export const P_DRAFT = "aaaaaaaa-0000-0000-0000-000000000004"; // only a draft release
export const P_LEGACY = "aaaaaaaa-0000-0000-0000-000000000005"; // W2 import, no work_uid

export const product = (over: Partial<MyBookProduct> & { id: string }): MyBookProduct => ({
  slug: over.id.slice(-1) === "1" ? "biology" : `book-${over.id.slice(-1)}`,
  title: null,
  status: "approved",
  work_uid: `w-${over.id.slice(-1)}`,
  language: "en",
  release_id: 10,
  release_kind: "final",
  cover_key: null,
  ...over,
});

export const release = (over: Partial<MyBookRelease> & { id: number; work_uid: string }): MyBookRelease => ({
  language: "en",
  release_kind: "final",
  title: `Release ${over.id}`,
  chapter_count: 10,
  digital_pdf_key: `books/x/editions/e${over.id}/digital.pdf`,
  cover_key: `books/x/editions/e${over.id}/cover.png`,
  superseded_by: null,
  withdrawn_at: null,
  ...over,
});

export const grant = (over: Partial<MyBookGrant> & { user_id: string; product_id: string }): MyBookGrant => ({
  source: "purchase",
  activated_at: "2026-10-01T00:00:00Z",
  expires_at: null,
  tutor_expires_at: null,
  revoked_at: null,
  usage_allowance: null,
  ...over,
});

export const PRODUCTS: MyBookProduct[] = [
  product({ id: P_BIO, title: "Biology: Cells", release_id: 12, cover_key: "books/bio/cover-old.png" }),
  product({ id: P_ALG, title: "Mastering Linear Equations", release_id: 20 }),
  product({ id: P_OLD, title: "Old Chemistry", status: "retired", release_id: null, release_kind: null }),
  product({ id: P_DRAFT, title: "Draft Physics", release_id: 40, release_kind: "draft" }),
  product({ id: P_LEGACY, title: "Biology (W2)", work_uid: null, language: null, release_id: null, release_kind: null }),
];

export const RELEASES: MyBookRelease[] = [
  // Biology: #11 superseded by #12 (live)
  release({ id: 11, work_uid: "w-1", superseded_by: 12 }),
  release({ id: 12, work_uid: "w-1", chapter_count: 10 }),
  // Biology also has a newer live DRAFT — never served
  release({ id: 13, work_uid: "w-1", release_kind: "draft", digital_pdf_key: null, cover_key: null }),
  release({ id: 20, work_uid: "w-2", chapter_count: 1 }),
  // Old Chemistry: withdrawn 2026-10-15
  release({ id: 30, work_uid: "w-3", withdrawn_at: "2026-10-15T00:00:00Z" }),
  // Draft Physics: a draft only
  release({ id: 40, work_uid: "w-4", release_kind: "draft", digital_pdf_key: null, cover_key: null }),
];
