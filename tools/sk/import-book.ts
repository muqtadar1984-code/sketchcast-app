// SK book import — load an approved edition of a whole book into the SK book-content tables (migration 0156).
//
//   npx tsx tools/sk/import-book.ts <path/to/sk-bundle.json> (--emit-sql out.sql | --dry-run)
//
// The bundle is written by the publishing engine (`python -m publishing.tools.sk_bundle`); it names every chapter
// draft (read from the bundle's folder), its approval, its catalogue topic and the curriculum links both validators
// agreed on. The rules are in import-book-lib.ts and, per chapter, the B1 exporter (export-lib.ts).
//
// This tool only WRITES SQL (one transaction for the whole book) or prints the plan. Apply the SQL to a BRANCH
// database first; loading it into production is a separate founder decision (distribution plan §8).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChapterDraft } from "./export-lib";
import { bookSql, validateBundle, type Bundle } from "./import-book-lib";

function main() {
  const argv = process.argv.slice(2);
  let bundlePath = "";
  let emit: string | null = null;
  let dry = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--emit-sql") emit = argv[++i] ?? null;
    else if (argv[i] === "--dry-run") dry = true;
    else if (!bundlePath) bundlePath = argv[i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  if (!bundlePath || (!emit && !dry)) throw new Error("usage: npx tsx tools/sk/import-book.ts <sk-bundle.json> (--emit-sql out.sql | --dry-run)");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Bundle;
  validateBundle(bundle);
  const drafts = new Map<number, ChapterDraft>();
  for (const ch of bundle.chapters) drafts.set(ch.number, JSON.parse(readFileSync(join(dirname(bundlePath), ch.draft), "utf8")) as ChapterDraft);
  const { sql, reports } = bookSql(bundle, drafts);
  console.log(`${bundle.product.slug} — ${bundle.product.edition} (${bundle.product.manuscript_version}), ${reports.length} chapters`);
  for (const r of reports) {
    const short = r.shortfall.length ? `; units short of auto-markable items: ${r.shortfall.map((s) => `${s.unit_key} ${s.auto_markable}/${s.needed}`).join(", ")}` : "";
    console.log(`  ch${r.chapter}: ${r.units} units, ${r.blocks} blocks, ${r.exercises} questions${r.exercises_skipped ? ` (skipped: ${r.exercises_skipped})` : ""}, links ${r.links.taught} taught + ${r.links.assessed} assessed${r.links.unplaced.length ? `, ${r.links.unplaced.length} unplaced` : ""}${short}`);
  }
  if (emit) {
    writeFileSync(emit, sql, "utf8");
    console.log(`\nSQL written to ${emit} — one transaction; its last statement returns the counts.`);
  }
}

const isCli = process.argv[1] !== undefined && /import-book\.(ts|js|mts|mjs)$/.test(process.argv[1]);
if (isCli) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
