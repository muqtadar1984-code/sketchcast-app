"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BoardSession, { type BoardIO, type SessionInfo, type SessionKit } from "@/app/present/board-session";
import type { PresentWords } from "@/app/present/present-client";
import {
  MemorySkActionSink,
  type BoardController,
  type BoardManifest,
  type SeekResult,
} from "@/app/present/board-controller";

// The in-memory side of the SK M2 harness. Everything the Board would send to
// the server lands in NET instead, SK actions land in the same in-memory sink
// the real page defaults to, and any stray /api/ request made from this page
// (the wrap-up drafts a recap on mount) is answered locally with a 404 and
// recorded, so nothing reaches a server at all.

type Net = {
  items: { kind: string; generationId: string | null }[];
  syncs: number;
  records: number;
  uploads: { path: string; bytes: number; type: string; pdfPages?: number }[];
  rollRecorded: number;
  closes: number[];
  blockedApi: string[];
};

declare global {
  interface Window {
    __skBoard?: { controller: BoardController; manifest: BoardManifest; sink: MemorySkActionSink; net: Net };
    __skM2?: { run: () => Promise<unknown>; seeks: (pass: string) => Promise<unknown>; last?: unknown };
  }
}

const SESSION: SessionInfo = {
  id: "00000000-0000-4000-8000-000000000002",
  teacherId: "00000000-0000-4000-8000-000000000000",
  bookId: "00000000-0000-4000-8000-000000000001",
  chapterNum: 1,
};

/** One harness per tab — module scope, outside React's state. */
const NET: Net = { items: [], syncs: 0, records: 0, uploads: [], rollRecorded: 0, closes: [], blockedApi: [] };
const SINK = new MemorySkActionSink();

let guarded = false;
function guardApi() {
  if (guarded || typeof window === "undefined") return;
  guarded = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let path = url;
    try {
      path = new URL(url, window.location.href).pathname;
    } catch {
      /* keep the raw string */
    }
    if (path.startsWith("/api/")) {
      NET.blockedApi.push(`${init?.method ?? "GET"} ${path}`);
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    return real(input, init);
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IO: BoardIO = {
  sync: async (records) => {
    NET.syncs++;
    NET.records += records.length;
  },
  items: async (items) => {
    NET.items.push(...items.map((i) => ({ kind: i.kind, generationId: i.generationId })));
  },
  signFrame: async () => null,
  upload: async (path, blob, type) => {
    let pdfPages: number | undefined;
    if (type === "application/pdf") {
      const text = new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
      pdfPages = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    }
    NET.uploads.push({ path, bytes: blob.size, type, pdfPages });
  },
  recordRoll: async () => {
    NET.rollRecorded++;
  },
  close: async (pageCount) => {
    NET.closes.push(pageCount);
    return true;
  },
};

const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

export default function Harness({
  t,
  manifest,
  hasVideo,
  hasQuestions,
}: {
  t: PresentWords;
  manifest: BoardManifest;
  hasVideo: boolean;
  hasQuestions: boolean;
}) {
  const ctl = useRef<BoardController | null>(null);
  const [report, setReport] = useState<string>("");

  useEffect(() => guardApi(), []);

  const kit = useMemo<SessionKit>(
    () => ({
      units: [
        {
          part: null,
          total: 1,
          video: hasVideo ? { id: "dev-video", title: "SK M2 kit video", urls: ["/dev/sk-board/video"] } : null,
          docs: [
            {
              id: "dev-worksheet",
              kind: "worksheet",
              projects: true,
              title: "Worksheet",
              download: null,
              questions: hasQuestions ? "/dev/sk-board/questions" : null,
            },
          ],
        },
      ],
      picker: [],
    }),
    [hasVideo, hasQuestions],
  );

  useEffect(() => {
    // Muted so a scripted play() is not refused by the autoplay policy — the
    // harness has no user gesture. The Board itself is unchanged.
    const v = document.querySelector<HTMLVideoElement>("[data-stage-mode] video");
    if (v) v.muted = true;

    const ready = async () => {
      const c = ctl.current;
      if (!c) throw new Error("controller not registered");
      const el = document.querySelector<HTMLVideoElement>("[data-stage-mode] video");
      if (el && el.readyState < 1) {
        await new Promise<void>((res) => el.addEventListener("loadedmetadata", () => res(), { once: true }));
      }
      return c;
    };

    /** Ten segment seeks (5 starts, 5 ends), with the displayed frame. */
    const seeks = async (pass: string) => {
      const c = await ready();
      const n = manifest.segments.length;
      const ks = n >= 5 ? [1, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1] : [];
      const rows: Record<string, unknown>[] = [];
      for (const edge of ["start", "end"] as const) {
        for (const k of ks) {
          const p = c.seekSegment(k, edge, manifest);
          const movingDuring = c.getState().moving;
          const r: SeekResult = await p;
          rows.push({
            pass,
            k,
            edge,
            target: +r.target.toFixed(3),
            landed: +r.landed.toFixed(3),
            errorMs: r1(r.errorMs),
            seekedMs: r1(r.latencyMs),
            mediaTime: r.presentedMediaTime === null ? null : +r.presentedMediaTime.toFixed(4),
            frameErrorMs: r1(r.frameErrorMs),
            frameMs: r1(r.frameLatencyMs),
            movingDuring,
            movingAfter: c.getState().moving,
            pass150: r.frameErrorMs !== null ? r.frameErrorMs <= 150 : null,
          });
          await wait(150);
        }
      }
      return rows;
    };

    const run = async () => {
      const c = await ready();
      const checks: { control: string; pass: boolean; detail: string }[] = [];
      const check = (control: string, pass: boolean, detail: string) => checks.push({ control, pass, detail });
      const videoItems = () => NET.items.filter((i) => i.kind === "video").length;
      const pageBg = () => document.querySelector("[data-stage-mode]")?.getAttribute("data-stage-mode");

      const s0 = c.getState();
      check("session open", !!s0.sessionId && !s0.ended, `id=${s0.sessionId} pages=${s0.pageCount}`);

      // play = the ▶ button (records a video item); resume = Resume (records nothing)
      const v0 = videoItems();
      await c.play();
      await wait(1200);
      let s = c.getState();
      check("play", !s.paused && s.t > 0.3 && videoItems() === v0 + 1, `t=${s.t.toFixed(2)} stage=${s.stageMode} videoItems ${v0}->${videoItems()}`);
      c.pause();
      await wait(200);
      s = c.getState();
      const tPaused = s.t;
      check("pause", s.paused, `t=${s.t.toFixed(2)}`);
      await wait(400);
      check("pause holds", Math.abs(c.getState().t - tPaused) < 0.01, `drift=${(c.getState().t - tPaused).toFixed(3)}s`);
      const v1 = videoItems();
      await c.resume();
      await wait(700);
      s = c.getState();
      check("resume (no item)", !s.paused && s.t > tPaused && videoItems() === v1, `t=${s.t.toFixed(2)} videoItems ${v1}->${videoItems()}`);
      c.pause();

      // The stage is full and visible: seeks, cold then warm, with displayed frames.
      const cold = await seeks("cold");
      const warm = await seeks("warm");

      // slide(k): the three verdict paths, on synthetic verdicts over the real manifest
      // (M1 adds real ones; these exercise the contract).
      const vm: BoardManifest = {
        segments: manifest.segments.map((g, k) =>
          k === 2
            ? { ...g, visual: { status: "distinct", show: "frame", reason: "harness: own slide" } }
            : k === 4
              ? { ...g, visual: { status: "misleading", show: "fallback_frame", fallback_k: 2, reason: "harness: reuses 2" } }
              : k === 6
                ? { ...g, visual: { status: "misleading", show: "caption_only", reason: "harness: misleading" } }
                : { ...g, visual: undefined },
        ),
      };
      const slides: Record<string, unknown>[] = [];
      if (vm.segments.length > 8) {
        const sf = await c.slide(2, vm);
        s = c.getState();
        check("slide frame", sf.shown === "frame" && sf.shownK === 2 && s.paused && s.stageMode === "full",
          `shownK=${sf.shownK} t=${s.t.toFixed(3)} slide_t=${vm.segments[2].slide_t} frameErr=${r1(sf.seek?.frameErrorMs ?? null)}ms`);
        slides.push({ k: 2, ...sf, seek: undefined, t: s.t });
        const fb = await c.slide(4, vm);
        s = c.getState();
        check("slide fallback_frame", fb.shown === "fallback_frame" && fb.shownK === 2 && Math.abs(s.t - (vm.segments[2].slide_t ?? 0)) < 0.05,
          `shownK=${fb.shownK} t=${s.t.toFixed(3)} (segment 4's own frame NOT shown)`);
        slides.push({ k: 4, ...fb, seek: undefined, t: s.t });
        for (const k of [6, 8]) {
          const before = c.getState().pageCount;
          const cap = await c.slide(k, vm);
          await wait(300);
          s = c.getState();
          check(`slide caption (k=${k}, ${k === 6 ? "misleading" : "no verdict"})`,
            cap.shown === "caption" && s.pageCount === before + 1 && s.stageMode === "away",
            `pages ${before}->${s.pageCount} stage=${s.stageMode} heading="${vm.segments[k].heading}"`);
          slides.push({ k, ...cap });
        }
      }

      // Freeze needs the stage up with a frame: show slide 2 again.
      if (vm.segments.length > 2) await c.slide(2, vm);
      let before = c.getState().pageCount;
      await c.freeze();
      await wait(300);
      s = c.getState();
      check("freeze -> roll page +1", s.pageCount === before + 1, `pages ${before}->${s.pageCount} stage=${pageBg()}`);

      before = s.pageCount;
      c.openWorksheetPage();
      await wait(300);
      s = c.getState();
      check("worksheet page push", s.pageCount === before + 1 && s.stageMode === "away", `pages ${before}->${s.pageCount}`);

      before = s.pageCount;
      c.blankPage();
      await wait(600);
      s = c.getState();
      check("blank page", s.pageCount === before + 1, `pages ${before}->${s.pageCount}, on page ${s.page + 1}`);

      const p0 = s.page;
      c.pageUp();
      await wait(700);
      const pUp = c.getState().page;
      check("page up", pUp === p0 - 1, `page ${p0 + 1}->${pUp + 1}`);
      c.pageDown();
      await wait(700);
      const pDown = c.getState().page;
      check("page down", pDown === pUp + 1, `page ${pUp + 1}->${pDown + 1}`);

      // Questions: the real questions.json, one page per question.
      const questions: Record<string, unknown> = {};
      if (hasQuestions) {
        const w0 = NET.items.filter((i) => i.kind === "worksheet").length;
        before = c.getState().pageCount;
        const q0 = await c.showQuestions();
        await wait(600);
        s = c.getState();
        const btnText = () => Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim() ?? "");
        const hasShow = btnText().includes(t.board.showAnswer);
        check("show questions", q0.index === 0 && q0.total > 0 && s.pageCount === before + 1 && NET.items.filter((i) => i.kind === "worksheet").length === w0 + 1,
          `q ${q0.index + 1}/${q0.total} pages ${before}->${s.pageCount} showAnswer button=${hasShow}`);
        const showBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === t.board.showAnswer);
        showBtn?.click();
        await wait(200);
        const toggled = btnText().includes(t.board.hideAnswer);
        showBtn?.click();
        await wait(200);
        check("answer toggle", hasShow && toggled && btnText().includes(t.board.showAnswer), `hidden by default, shows, hides again`);
        const q1 = await c.nextQuestion();
        await wait(600);
        const afterNext = c.getState().pageCount;
        const qb = await c.prevQuestion();
        await wait(600);
        const afterPrev = c.getState();
        const q1again = await c.nextQuestion();
        await wait(600);
        check("next / previous question", q1.index === 1 && qb.index === 0 && q1again.index === 1 && afterPrev.pageCount === afterNext && c.getState().pageCount === afterNext,
          `next→${q1.index + 1}, prev→${qb.index + 1} (page ${afterPrev.page + 1}), next again reuses its page; pages=${afterNext}`);
        questions.total = q0.total;
      }

      const pagesAtEnd = c.getState().pageCount;
      await c.endSession();
      await wait(300);
      s = c.getState();
      const pdf = NET.uploads.find((u) => u.type === "application/pdf");
      check("session close + PDF", s.ended && NET.closes.length === 1 && NET.closes[0] === pagesAtEnd && pdf?.pdfPages === pagesAtEnd,
        `closes=${JSON.stringify(NET.closes)} pdf=${pdf?.bytes}B/${pdf?.pdfPages}pp (roll ${pagesAtEnd})`);

      const acts = s.actions;
      check("every move recorded as an sk_actions row (in memory)",
        acts.length > 0 && acts.length === SINK.records.length && acts.every((a) => a.kind === "board" && a.tier === "immediate" && a.action.startsWith("board.") && a.ok),
        `${acts.length} actions, ${SINK.records.length} in sink, failed=${acts.filter((a) => !a.ok).length}`);
      check("no /api/present/items call from the page", !NET.blockedApi.some((b) => b.includes("/api/present/items")),
        `blocked: ${JSON.stringify(NET.blockedApi)}`);

      const out = {
        duration: s.duration,
        seeks: [...cold, ...warm],
        slides,
        questions,
        checks,
        net: NET,
        actions: acts.map((a) => `${a.action}${a.ok ? "" : "!"}`).join(","),
      };
      window.__skM2!.last = out;
      setReport(JSON.stringify({ checks, seeks: out.seeks }, null, 1));
      return out;
    };
    window.__skM2 = { run, seeks };
  }, [manifest, hasQuestions, t]);

  // Registered once the BoardSession has filled the ref.
  useEffect(() => {
    const id = setInterval(() => {
      if (ctl.current) {
        window.__skBoard = { controller: ctl.current, manifest, sink: SINK, net: NET };
        clearInterval(id);
      }
    }, 50);
    return () => clearInterval(id);
  }, [manifest]);

  return (
    <>
      <BoardSession session={SESSION} kit={kit} t={t} onEnd={() => {}} io={IO} controllerRef={ctl} skSink={SINK} />
      {report && (
        <pre id="sk-m2-report" className="m-3 max-h-[40vh] overflow-auto rounded bg-black p-2 font-mono text-[10px] text-[#9FE]">
          {report}
        </pre>
      )}
    </>
  );
}
