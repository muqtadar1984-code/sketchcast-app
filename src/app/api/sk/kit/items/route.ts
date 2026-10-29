import { NextResponse } from "next/server";
import { stripItem } from "@/sk/items";
import { kitDeps, parseKitQuery, readyManifest, resolveKit } from "@/sk/kit-server";
import { practiseItemIds } from "@/sk/kit-view";
import { gate } from "@/sk/server";

export const runtime = "nodejs";

// GET /api/sk/kit/items?product&chapter&kit&segment=<manifest key>
//   → { segment, items: KitPractiseItem[] }   (SK S3 slice B, the practise move)
// The section's mapped bank items (itemsForSegment, bank-traced only), stripped
// of every marking field — the answer key never reaches the browser. Not
// metered: practice is prepared teaching. 409 { status: "preparing" } while the
// kit map is not ready.

const PRACTISE_MAX = 5;
const KEY_RE = /^p\d{1,3}:[A-Za-z0-9_.-]{1,64}$/;

export async function GET(request: Request) {
  const g = await gate();
  if (!g.ok) return g.response;
  const sp = new URL(request.url).searchParams;
  const q = parseKitQuery({ product: sp.get("product"), chapter: sp.get("chapter"), kit: sp.get("kit") });
  const segment = sp.get("segment") ?? "";
  if (!q || !KEY_RE.test(segment)) return NextResponse.json({ error: "product, chapter and segment are required." }, { status: 400 });
  const deps = kitDeps();
  try {
    const r = await resolveKit(deps, g.userId, q);
    if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.status });
    const ready = await readyManifest(deps, r);
    if (!ready) return NextResponse.json({ status: "preparing" }, { status: 409 });
    const bank = deps.items(ready.admin);
    const ids = practiseItemIds(ready.manifest, segment).slice(0, PRACTISE_MAX);
    const items = (await Promise.all(ids.map((id) => bank.get(id)))).filter((x): x is NonNullable<typeof x> => !!x).map(stripItem);
    return NextResponse.json({ segment, items });
  } catch (e) {
    console.error("[sk] kit items failed:", (e as Error).message);
    return NextResponse.json({ error: "The practice questions could not be loaded." }, { status: 500 });
  }
}
