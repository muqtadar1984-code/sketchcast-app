import { readFile } from "node:fs/promises";

// DEV ONLY: serves the questions.json at SK_M2_QUESTIONS_PATH to the SK M2
// harness, standing in for the signed URL /api/present/kit returns.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("Not found", { status: 404 });

export async function GET() {
  if (process.env.NODE_ENV !== "development") return NOT_FOUND();
  const path = process.env.SK_M2_QUESTIONS_PATH;
  if (!path || !path.toLowerCase().endsWith(".json")) return NOT_FOUND();
  try {
    const text = await readFile(path, "utf8");
    JSON.parse(text); // refuse anything that is not JSON
    return new Response(text, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return NOT_FOUND();
  }
}
