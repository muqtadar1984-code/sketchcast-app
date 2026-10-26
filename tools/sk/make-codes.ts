// Generate a print batch of SK book codes.
//
//   npx tsx tools/sk/make-codes.ts \
//     --batch <print_batches.id> --product <product uuid> --prefix SKB2 --count 500 \
//     --out codes-SKB2.csv [--insert]
//
// Writes the PLAIN codes to the CSV (hand it to the printer, then delete it —
// it is the only copy) and, with --insert, stores ONLY their HMACs in
// book_codes (needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BOOK_CODE_SECRET
// in the environment). Never run against production without the founder's
// go-ahead; the branch database is the place to try it.

import { writeFileSync } from "node:fs";
import { formatCode, generateCode, hmacCode, normalizeCode } from "../../src/sk/access";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "true" : process.argv[++i]!);
}
const batch = args.get("batch");
const product = args.get("product");
const prefix = normalizeCode(args.get("prefix") ?? "SKB2");
const count = Number(args.get("count") ?? "0");
const out = args.get("out") ?? `codes-${prefix}.csv`;
const insert = args.get("insert") === "true";
if (!batch || !product || !count) {
  console.error("usage: --batch <id> --product <uuid> --prefix SKB2 --count N [--out file.csv] [--insert]");
  process.exit(2);
}

const codes = new Set<string>();
while (codes.size < count) codes.add(generateCode(prefix));
const rows = [...codes].map((c) => ({ code: c, printed: formatCode(c), hmac: process.env.BOOK_CODE_SECRET ? hmacCode(c, process.env.BOOK_CODE_SECRET) : "" }));
writeFileSync(out, "printed_code\n" + rows.map((r) => r.printed).join("\n") + "\n", "utf-8");
console.log(`${rows.length} codes written to ${out} (plain text — deliver to the printer, then delete)`);

if (insert) {
  const secret = process.env.BOOK_CODE_SECRET ?? "";
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (secret.length < 16 || !url || !key) {
    console.error("--insert needs BOOK_CODE_SECRET (>= 16 chars), SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ code_hmac: r.hmac, product_id: product, batch_id: batch }));
    const { error } = await sb.from("book_codes").insert(chunk);
    if (error) {
      console.error("insert failed:", error.message);
      process.exit(1);
    }
  }
  console.log(`${rows.length} HMACs inserted into book_codes for batch ${batch}`);
}
