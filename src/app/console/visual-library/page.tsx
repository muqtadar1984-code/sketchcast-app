import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import {
  ASSET_COLUMNS,
  FACET_SCAN_LIMIT,
  PAGE_SIZE,
  SIGN_TTL_SECONDS,
  SORTS,
  type GalleryItem,
  type VisualAsset,
  duplicateKeys,
  facetsFrom,
  hasActiveFilters,
  isMissingTable,
  pageCount,
  pageRange,
  parseFilters,
  searchExpression,
} from "@/utils/visual-library";
import Gallery from "./gallery";

// Staff-only visual gallery over the reusable visual library.
//
// READ-ONLY BY DESIGN (v1): no delete, no bulk actions, no regeneration, no
// editing, no generation controls. It exists so a human can look at the actual
// artwork and judge it.
//
// Access: the /console layout calls requirePlatformAdmin(), so reaching this
// page already means staff. There is no API route to guard because the page
// never exposes one — rows and signed URLs are produced in this Server
// Component and handed to the client as props. The service-role key stays on
// the server (createAdminClient is server-only), and the "visual-assets"
// bucket stays PRIVATE: the browser only ever sees short-lived signed URLs.

export const dynamic = "force-dynamic";

const MIGRATION_HINT =
  "database/visual_asset_library.sql on feature/visual-knowledge-library (worker repo, PR #15)";

export default async function VisualLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const f = parseFilters(await searchParams);
  const admin = createAdminClient();

  let query = admin
    .from("visual_assets")
    .select(ASSET_COLUMNS, { count: "exact" })
    .order(SORTS[f.sort].column, {
      ascending: SORTS[f.sort].ascending,
      // last_used_at is null for anything never used; those belong at the end
      // of "recently used", not the top.
      nullsFirst: false,
    });

  // Filters COMBINE (the brief is explicit) — each is another AND on one query,
  // resolved in Postgres, never by filtering a big result set in the browser.
  if (f.type !== "all") query = query.eq("asset_type", f.type);
  if (f.subject) query = query.eq("subject", f.subject);
  if (f.grade) query = query.eq("grade", f.grade);
  if (f.curriculum) query = query.eq("curriculum", f.curriculum);
  if (f.topic) query = query.eq("topic", f.topic);
  if (f.status) query = query.eq("status", f.status);
  if (f.concept) query = query.contains("concepts", [f.concept]);
  const search = searchExpression(f.q);
  if (search) query = query.or(search);

  const [from, to] = pageRange(f.page);
  const { data, error, count } = await query.range(from, to);

  // The library's table lives in the worker repo and may not be migrated yet.
  // Same convention as /console/content's `opsReady`: explain it, don't crash.
  if (isMissingTable(error)) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-3">
          The <span className="font-medium">visual_assets</span> table is not in this database yet.
          Apply <span className="font-medium">{MIGRATION_HINT}</span>, then reload. The gallery is
          ready for the rows the visual library will populate.
        </p>
      </main>
    );
  }
  if (error) {
    return (
      <main className="max-w-7xl mx-auto px-6 py-10">
        <Heading />
        <p className="text-sm text-[#B42318] bg-[#FFF1F0] rounded-lg px-4 py-3">
          Could not read the visual library: {error.message}
        </p>
      </main>
    );
  }

  const rows = (data ?? []) as unknown as VisualAsset[];

  // Facet options come from the data, so a subject nobody predicted still
  // appears in the dropdown. Capped scan — see FACET_SCAN_LIMIT.
  const { data: facetRows } = await admin
    .from("visual_assets")
    .select("subject, grade, curriculum, topic")
    .limit(FACET_SCAN_LIMIT);
  const facets = facetsFrom(
    (facetRows ?? []) as unknown as Pick<VisualAsset, "subject" | "grade" | "curriculum" | "topic">[],
  );

  // ONE batch signing call for the whole page instead of N round-trips. The
  // same URL backs both the grid thumbnail and the detail view, so opening an
  // asset costs no further signing.
  const paths = rows.map((r) => r.storage_path).filter((p): p is string => !!p);
  const signed = new Map<string, string>();
  if (paths.length) {
    const { data: urls } = await admin.storage
      .from("visual-assets")
      .createSignedUrls(paths, SIGN_TTL_SECONDS);
    for (const u of urls ?? []) {
      // A path that fails to sign (object deleted from the bucket while its
      // row survives) comes back with an error and no signedUrl — that asset
      // gets the missing-image state rather than a broken <img>.
      if (u?.path && u.signedUrl && !u.error) signed.set(u.path, u.signedUrl);
    }
  }

  const items: GalleryItem[] = rows.map((asset) => ({
    asset,
    url: asset.storage_path ? (signed.get(asset.storage_path) ?? null) : null,
  }));

  const total = count ?? rows.length;
  const missing = items.filter((i) => !i.url).length;

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <Heading />
      <p className="text-[#5B6470] mb-5">
        Every reusable visual and avatar in the library, as artwork rather than filenames. Review
        only — nothing here changes the generation pipeline.
      </p>
      <Gallery
        items={items}
        filters={f}
        facets={facets}
        total={total}
        pages={pageCount(total)}
        pageSize={PAGE_SIZE}
        missing={missing}
        duplicates={[...duplicateKeys(rows)]}
        filtered={hasActiveFilters(f)}
      />
    </main>
  );
}

function Heading() {
  return (
    <>
      <h1 className="text-4xl mb-2">Visual Library</h1>
      <InkUnderline className="block h-3 w-32 mb-3" />
    </>
  );
}
