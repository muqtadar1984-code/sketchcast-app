import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The app's docs/sk-b2 folder, found by walking up from this module's own
 * location (compiled under .next/ in dev; the dev server's cwd is wherever
 * `next dev <dir>` was launched from) to the directory that holds both
 * package.json and docs/SK-CONTRACTS.md. */
function docsDir(): string {
  const starts: string[] = [];
  try {
    starts.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* no import.meta.url */
  }
  starts.push(process.cwd());
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "docs", "SK-CONTRACTS.md"))) return path.join(dir, "docs", "sk-b2");
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return path.join(process.cwd(), "docs", "sk-b2");
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!/^[a-z0-9-]{1,40}$/.test(name)) return Response.json({ error: "bad name" }, { status: 400 });
  const kind = new URL(req.url).searchParams.get("kind") === "json" ? "json" : "jpg";
  const buf = Buffer.from(await req.arrayBuffer());
  if (kind === "json") {
    if (buf.length > 4_000_000) return Response.json({ error: "too big" }, { status: 413 });
    try {
      JSON.parse(buf.toString("utf-8"));
    } catch {
      return Response.json({ error: "not json" }, { status: 400 });
    }
    const dir = path.join(docsDir(), "measurements");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${name}.json`), buf);
    return Response.json({ ok: true, path: `docs/sk-b2/measurements/${name}.json` });
  }
  if (buf.length < 100 || buf.length > 2_000_000 || buf[0] !== 0xff || buf[1] !== 0xd8) return Response.json({ error: "not a jpeg" }, { status: 413 });
  const dir = docsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.jpg`), buf);
  return Response.json({ ok: true, path: `docs/sk-b2/${name}.jpg` });
}
