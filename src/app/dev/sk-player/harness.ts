// SK B2 harness — the §5.3 trial runner and the screenshot helper (dev only).
//
// `?auto=interrupt:20` asks 20 times at random moments (each ask is sent
// TWICE with the same event id — the replay must be ignored); `?auto=reload:10`
// reloads the page 10 times mid-segment and records what the runtime
// restored. Trial state lives in sessionStorage so it survives the reloads.

import type { SpikeRuntime } from "@/sk/board/runtime";

export type AutoMode = "interrupt" | "reload";
export type AutoState = { unit: string; mode: AutoMode; total: number; done: number; startedAt: number; results: unknown[] };
const KEY = "sk-b2:auto";

export function parseAuto(param: string | null): { mode: AutoMode; total: number } | null {
  const m = /^(interrupt|reload):(\d{1,3})$/.exec(param ?? "");
  return m ? { mode: m[1] as AutoMode, total: Number(m[2]) } : null;
}
export function readAuto(): AutoState | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AutoState) : null;
  } catch {
    return null;
  }
}
export function writeAuto(s: AutoState | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class AutoHarness {
  private stopped = false;
  constructor(
    private readonly rt: SpikeRuntime,
    private readonly unit: string,
    private readonly ask: () => Promise<unknown>,
    private readonly log: (s: string) => void,
  ) {}

  stop(): void {
    this.stopped = true;
  }

  private async ensurePlaying(): Promise<boolean> {
    const rt = this.rt;
    if (rt.state === "done") rt.seek(0);
    if (rt.state === "playing") return true;
    return rt.playAsync();
  }

  /** 20 barge-ins at random points; the clip loops when it ends. */
  async runInterrupts(total: number): Promise<void> {
    const st: AutoState = { unit: this.unit, mode: "interrupt", total, done: 0, startedAt: Date.now(), results: [] };
    writeAuto(st);
    this.log(`auto: ${total} interrupt trials`);
    while (!this.stopped && st.done < total) {
      if (!(await this.ensurePlaying())) {
        this.log("auto: play blocked — click Play to continue");
        return;
      }
      await sleep(rand(1500, 3500));
      if (this.stopped) break;
      if (this.rt.state !== "playing") continue;
      await this.ask();
      st.done++;
      writeAuto(st);
    }
    writeAuto(null);
    this.log(`auto: interrupt trials finished (${st.done}/${total})`);
  }

  /** First call: start the reload series; later calls (after each reload) record and continue. */
  async continueReloads(state: AutoState | null, total = 10): Promise<void> {
    const rt = this.rt;
    let st = state;
    if (!st) {
      st = { unit: this.unit, mode: "reload", total, done: 0, startedAt: Date.now(), results: [] };
      writeAuto(st);
      this.log(`auto: ${total} reload trials`);
    } else {
      // We are back after a reload: the runtime restored at mount; wait for the seek to report.
      await sleep(1700);
      const rec = rt.measure.reloadRecovery[0] ?? null;
      st.results.push(rec);
      st.done++;
      writeAuto(st);
      this.log(`auto: reload ${st.done}/${st.total} → ${rec ? `${rec.saved}→${rec.resumed} ms, board ${rec.boardMatch ? "same" : "DIFF"}, seek ${rec.seekExact === null ? "?" : rec.seekExact ? "exact" : "OFF"}` : "NO RECOVERY"}`);
      if (st.done >= st.total) {
        this.log(`auto: reload trials finished — ${st.results.filter((r) => (r as { boardMatch?: boolean } | null)?.boardMatch).length}/${st.total} same board`);
        (window as unknown as { __skReloadResults?: unknown[] }).__skReloadResults = st.results;
        writeAuto(null);
        return;
      }
    }
    if (!(await this.ensurePlaying())) {
      this.log("auto: play blocked after reload — click Play to continue");
      return;
    }
    await sleep(rand(2500, 6500));
    if (this.stopped) return;
    if (rt.state !== "playing") {
      if (!(await this.ensurePlaying())) return;
      await sleep(1500);
    }
    this.log("auto: reloading mid-segment…");
    location.reload();
  }
}

/** Composite the clip frame and the SVG overlay into one JPEG and send it to
 * the dev route, which writes docs/sk-b2/<name>.jpg. */
export async function snapshot(video: HTMLVideoElement, host: HTMLElement, name: string): Promise<string> {
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("no board");
  const W = video.videoWidth || 1280;
  const H = video.videoHeight || 720;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0, W, H);
  // An <img> rendering an SVG cannot fetch external images: inline them.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(W));
  clone.setAttribute("height", String(H));
  for (const im of Array.from(clone.querySelectorAll("image"))) {
    const href = im.getAttribute("href") ?? "";
    if (!href.startsWith("/")) continue;
    const blob = await fetch(href).then((r) => r.blob());
    const data = await new Promise<string>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.readAsDataURL(blob);
    });
    im.setAttribute("href", data);
    im.setAttributeNS("http://www.w3.org/1999/xlink", "href", data);
  }
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  await new Promise<void>((res, rej) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, H);
      res();
    };
    img.onerror = () => rej(new Error("overlay render failed"));
    img.src = url;
  });
  URL.revokeObjectURL(url);
  const jpeg = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  if (!jpeg) throw new Error("no jpeg");
  const r = await fetch(`/dev/sk-player/snap?name=${encodeURIComponent(name)}`, { method: "POST", body: jpeg });
  const j = (await r.json()) as { ok?: boolean; path?: string; error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? "snapshot refused");
  return j.path!;
}
