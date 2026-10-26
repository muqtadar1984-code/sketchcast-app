import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// SK B2 harness — DEV ONLY: receives a JPEG from the harness page and writes
// it to docs/sk-b2/<name>.jpg (the B2 report's evidence). 404 on a
// production build; the name is a short token; the body must be a JPEG under
// 2 MB. Nothing else is written anywhere.
export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!/^[a-z0-9-]{1,40}$/.test(name)) return Response.json({ error: "bad name" }, { status: 400 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 100 || buf.length > 2_000_000 || buf[0] !== 0xff || buf[1] !== 0xd8) return Response.json({ error: "not a jpeg" }, { status: 413 });
  const dir = path.join(process.cwd(), "docs", "sk-b2");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.jpg`), buf);
  return Response.json({ ok: true, path: `docs/sk-b2/${name}.jpg` });
}
