// Mint the EDITION code for a KDP edition of a book.
//
//   npx tsx tools/sk/make-edition-code.ts \
//     --product <sk_book_products.id> --edition kdp-2026-1 [--cap 50] \
//     [--allowance '{"live_turns":120}'] [--insert]
//
// Prints the PLAIN code once (the publishing side writes it into the book's
// kdp.json so it is printed on the activation page of every copy) and, with
// --insert, stores ONLY its HMAC in edition_codes (needs SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, BOOK_CODE_SECRET in the environment). One code
// per (product, edition). Never run against production without the founder's
// go-ahead; the branch database is the place to try it.

import { formatCode, generateEditionCode, hmacCode } from "../../src/sk/access";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] == null ? "true" : process.argv[++i]!);
}
const product = args.get("product");
const edition = args.get("edition");
const cap = Number(args.get("cap") ?? "50");
const allowanceRaw = args.get("allowance");
const insert = args.get("insert") === "true";
if (!product || !edition || !Number.isInteger(cap) || cap <= 0) {
  console.error("usage: --product <uuid> --edition <name> [--cap N] [--allowance '{\"live_turns\":120}'] [--insert]");
  process.exit(2);
}
let allowance: unknown = null;
if (allowanceRaw) {
  try {
    allowance = JSON.parse(allowanceRaw);
  } catch {
    console.error("--allowance must be JSON, e.g. '{\"live_turns\":120}'");
    process.exit(2);
  }
}

const code = generateEditionCode();
console.log(`Edition code for ${edition}: ${formatCode(code)}  (plain text — shown once; write it into kdp.json, never into the database)`);

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
  const { error } = await sb.from("edition_codes").insert({ product_id: product, edition, code_hmac: hmacCode(code, secret), daily_cap: cap, usage_allowance: allowance });
  if (error) {
    console.error("insert failed:", error.message);
    process.exit(1);
  }
  console.log(`HMAC inserted into edition_codes for product ${product}, edition ${edition}, daily cap ${cap}`);
}
