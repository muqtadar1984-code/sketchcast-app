// SK home hero (2026-10-30): flatten each rig's layers (body + arm + head, at
// the positions rig.json gives in SOURCE pixels) into ONE still portrait,
// cropped to head and shoulders, for the hero card. The rig's body.png has the
// head cut out (the animated avatar draws it as its own layer), so the hero
// cannot show body.png alone. Re-run when a rig changes:
//   node scripts/sk-portraits.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_W = 480; // 2.5× the hero's 192 px box
const OUT_H = 360; // the box's 4:3

for (const look of ["sk-a", "sk-b"]) {
  const dir = resolve(ROOT, "public/sk/rig", look);
  const rig = JSON.parse(readFileSync(resolve(dir, "rig.json"), "utf8"));
  const layer = (name) => ({ input: resolve(dir, `${name}.png`), left: rig[name].x0, top: rig[name].y0 });
  const flat = await sharp({ create: { width: rig.w, height: rig.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([layer("body"), layer("arm"), layer("head")])
    .png()
    .toBuffer();
  // Head and shoulders: centred on the head, from just above it to about one
  // head-height below the chin, at the box's aspect.
  const head = rig.head;
  const headH = head.y1 - head.y0;
  const top = Math.max(0, head.y0 - Math.round(headH * 0.08));
  let height = Math.min(rig.h - top, Math.round(headH * 1.5));
  let width = Math.round((height * OUT_W) / OUT_H);
  if (width > rig.w) {
    // never stretch: a crop wider than the source shrinks to keep the aspect
    width = rig.w;
    height = Math.round((width * OUT_H) / OUT_W);
  }
  const cx = Math.round((head.x0 + head.x1) / 2);
  const left = Math.min(Math.max(0, cx - Math.round(width / 2)), rig.w - width);
  await sharp(flat)
    .extract({ left, top, width, height })
    .resize(OUT_W, OUT_H)
    .webp({ quality: 86 })
    .toFile(resolve(ROOT, "public/sk/portrait", `${look}.webp`));
  console.log(look, { left, top, width, height });

  // The full figure (founder 2026-10-30: "keep the full size avatar instead of
  // just the head") for the corner avatar: the same flattened layers, trimmed
  // to the figure's own outline, FULL_H px tall (about 3× its on-screen size).
  const FULL_H = 480;
  const trimmed = await sharp(flat).trim({ threshold: 1 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  await sharp(trimmed)
    .resize({ height: FULL_H })
    .webp({ quality: 86 })
    .toFile(resolve(ROOT, "public/sk/portrait", `${look}-full.webp`));
  console.log(`${look}-full`, { w: meta.width, h: meta.height, out: `${Math.round(((meta.width ?? 0) * FULL_H) / (meta.height ?? 1))}x${FULL_H}` });
}
