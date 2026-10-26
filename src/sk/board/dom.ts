// SK board — the only way a node reaches the board (plan §14, contracts §2).
//
// Every element is `createElementNS`; every text is `textContent`; every tag
// and attribute is checked against an allow-list BEFORE it is set, and a
// violation throws (never a partial write). No `on*`, no `style`, no `href`
// (images go through `setImageHref`, which accepts a site-local path only),
// no `foreignObject`/`script`/`use`/`a`, no `url(…)` except an internal mask
// reference. The checks are pure functions so they are unit-tested without a
// DOM (`assertTag`, `assertAttr`, `assertImageHref`).

export const NS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

export class BoardError extends Error {}

/** Tags the board may create. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set(["svg", "g", "defs", "mask", "rect", "path", "ellipse", "circle", "line", "text", "image"]);
/** Attributes the board may set. */
export const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d",
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "transform", "font-family", "font-size", "text-anchor", "pathLength", "mask", "maskUnits", "id",
  "data-id", "data-layer", "preserveAspectRatio",
]);
const MASK_REF_RE = /^url\(#[a-z][a-z0-9_.-]{0,80}\)$/i;
const ID_RE = /^[a-z][a-z0-9_.-]{0,80}$/i;
const COLOR_RE = /^(#[0-9a-f]{3,8}|none|[a-z]{3,20})$/i;
const IMG_RE = /^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(png|jpg|jpeg|webp)$/i;
/** `d`, `transform`, `viewBox`, `points`-like values: numbers, letters, punctuation only. */
const GEOM_RE = /^[a-z0-9 .,()\-+e]*$/i;
const FONT_RE = /^[a-z0-9 ,'"-]{1,80}$/i;

export function assertTag(tag: string): void {
  if (!ALLOWED_TAGS.has(tag)) throw new BoardError(`tag not allowed: ${tag}`);
}

/** Throws unless (k, v) may be set on a board node. */
export function assertAttr(k: string, v: string | number): void {
  if (!ALLOWED_ATTRS.has(k)) throw new BoardError(`attribute not allowed: ${k}`);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new BoardError(`${k}: not finite`);
    return;
  }
  if (v.length > 200_000) throw new BoardError(`${k}: too long`);
  switch (k) {
    case "mask":
      if (!MASK_REF_RE.test(v)) throw new BoardError("mask must reference an internal id");
      return;
    case "id":
    case "data-id":
    case "data-layer":
      if (!ID_RE.test(v)) throw new BoardError(`${k}: bad id`);
      return;
    case "fill":
    case "stroke":
      if (!COLOR_RE.test(v)) throw new BoardError(`${k}: bad colour`);
      return;
    case "font-family":
      if (!FONT_RE.test(v)) throw new BoardError("font-family: bad value");
      return;
    case "stroke-linecap":
    case "stroke-linejoin":
    case "text-anchor":
    case "maskUnits":
    case "preserveAspectRatio":
      if (!/^[a-z]+(\s[a-z]+)?$/i.test(v)) throw new BoardError(`${k}: bad keyword`);
      return;
    case "width":
    case "height":
      if (!/^[0-9.]+(%|px)?$/.test(v)) throw new BoardError(`${k}: bad length`);
      return;
    default:
      if (!GEOM_RE.test(v)) throw new BoardError(`${k}: bad value`);
  }
}

/** Image sources: a site-local path under /, no scheme, no `..`. */
export function assertImageHref(url: string): void {
  if (typeof url !== "string" || !IMG_RE.test(url) || url.includes("..")) throw new BoardError("image href must be a local path");
}

export function setAttr(e: Element, k: string, v: string | number): void {
  assertAttr(k, v);
  e.setAttribute(k, String(v));
}

/** Creates an SVG element with validated attributes. */
export function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  assertTag(tag);
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) setAttr(e, k, v);
  return e;
}

/** The only way an image source reaches the board. */
export function setImageHref(img: SVGImageElement, url: string): void {
  assertImageHref(url);
  img.setAttributeNS(XLINK, "href", url);
  img.setAttribute("href", url);
}

/** A paused animation we scrub. `pathLength=1` makes dashoffset length-agnostic. */
export function drawOn(target: SVGElement, start: number, dur: number): Animation {
  setAttr(target, "pathLength", 1);
  setAttr(target, "stroke-dasharray", 1);
  setAttr(target, "stroke-dashoffset", 1);
  const a = target.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { delay: start, duration: Math.max(1, dur), fill: "both" });
  a.pause();
  return a;
}

export function fadeIn(target: SVGElement, start: number, dur: number): Animation {
  setAttr(target, "opacity", 0);
  const a = target.animate([{ opacity: 0 }, { opacity: 1 }], { delay: start, duration: Math.max(1, dur), fill: "both" });
  a.pause();
  return a;
}
