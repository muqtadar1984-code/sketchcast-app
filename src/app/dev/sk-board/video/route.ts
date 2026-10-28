import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

// DEV ONLY: streams the mp4 at SK_M2_VIDEO_PATH with Range support, so the
// harness's <video> can seek without the file ever being committed or uploaded.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => new Response("Not found", { status: 404 });

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") return NOT_FOUND();
  const path = process.env.SK_M2_VIDEO_PATH;
  if (!path || !path.toLowerCase().endsWith(".mp4")) return NOT_FOUND();

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return NOT_FOUND();
  }

  const headers: Record<string, string> = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const range = request.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m) {
    headers["content-length"] = String(size);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
  }

  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (Number.isNaN(start)) {
    // suffix range: the last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  headers["content-range"] = `bytes ${start}-${end}/${size}`;
  headers["content-length"] = String(end - start + 1);
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
    status: 206,
    headers,
  });
}
