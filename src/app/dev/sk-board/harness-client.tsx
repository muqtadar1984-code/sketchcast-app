"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BoardSession, { type BoardIO, type SessionInfo, type SessionKit } from "@/app/present/board-session";
import type { PresentWords } from "@/app/present/present-client";
import type { BoardController, BoardManifest, SkMove } from "@/app/present/board-controller";

// The in-memory side of the SK M2 harness. Everything the Board would send to
// the server lands in `sink` instead, and any stray /api/ request made from
// this page (the wrap-up drafts a recap on mount) is answered locally with a
// 404 and recorded, so nothing reaches a server at all.

type Sink = {
  items: { kind: string; generationId: string | null; detail: Record<string, unknown> }[];
  syncs: number;
  records: number;
  uploads: { path: string; bytes: number; type: string }[];
  rollRecorded: number;
  closes: number[];
  moves: SkMove[];
  blockedApi: string[];
};

declare global {
  interface Window {
    __skBoard?: { controller: BoardController; manifest: BoardManifest; sink: Sink };
    __skM2?: { run: () => Promise<unknown>; last?: unknown };
  }
}

const SESSION: SessionInfo = {
  id: "00000000-0000-4000-8000-000000000002",
  teacherId: "00000000-0000-4000-8000-000000000000",
  bookId: "00000000-0000-4000-8000-000000000001",
  chapterNum: 1,
};

/** One harness per tab, so one sink — module scope, outside React's state. */
const SINK: Sink = {
  items: [],
  syncs: 0,
  records: 0,
  uploads: [],
  rollRecorded: 0,
  closes: [],
  moves: [],
  blockedApi: [],
};

let guarded = false;
function guardApi(sink: Sink) {
  if (guarded || typeof window === "undefined") return;
  guarded = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("/") ? url : (() => { try { return new URL(url).pathname; } catch { return url; } })();
    if (path.startsWith("/api/")) {
      sink.blockedApi.push(`${init?.method ?? "GET"} ${path}`);
      return Promise.resolve(new Response("{}", { status: 404 }));
    }
    return real(input, init);
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Harness({
  t,
  manifest,
  hasVideo,
}: {
  t: PresentWords;
  manifest: BoardManifest;
  hasVideo: boolean;
}) {
  const sink = SINK;
  // Before anything on the page can reach a server.
  useEffect(() => guardApi(sink), [sink]);

  const ctl = useRef<BoardController | null>(null);
  // Stable, or the Board would rebuild its controller (and its move history)
  // on every render.
  const moveLogger = useCallback((m: SkMove) => {
    sink.moves.push(m);
  }, [sink]);
  const [report, setReport] = useState<string>("");

  const io = useMemo<BoardIO>(
    () => ({
      sync: async (records) => {
        sink.syncs++;
        sink.records += records.length;
      },
      items: async (items) => {
        sink.items.push(...items);
      },
      signFrame: async () => null,
      upload: async (path, blob, type) => {
        sink.uploads.push({ path, bytes: blob.size, type });
      },
      recordRoll: async () => {
        sink.rollRecorded++;
      },
      close: async (pageCount) => {
        sink.closes.push(pageCount);
        return true;
      },
    }),
    [sink],
  );

  const kit = useMemo<SessionKit>(
    () => ({
      units: [
        {
          part: null,
          total: 1,
          video: hasVideo ? { id: "dev-video", title: "SK M2 kit video", urls: ["/dev/sk-board/video"] } : null,
          docs: [{ id: "dev-worksheet", kind: "worksheet", projects: true, title: "Worksheet", download: null }],
        },
      ],
      picker: [],
    }),
    [hasVideo],
  );

  useEffect(() => {
    // Muted so a scripted play() is not refused by the autoplay policy — the
    // harness has no user gesture. The Board itself is unchanged.
    const v = document.querySelector<HTMLVideoElement>("[data-stage-mode] video");
    if (v) v.muted = true;

    const run = async () => {
      const c = ctl.current;
      if (!c) throw new Error("controller not registered");
      const v2 = document.querySelector<HTMLVideoElement>("[data-stage-mode] video");
      if (v2 && v2.readyState < 1) {
        await new Promise<void>((res) => v2.addEventListener("loadedmetadata", () => res(), { once: true }));
      }
      const checks: { control: string; pass: boolean; detail: string }[] = [];
      const check = (control: string, pass: boolean, detail: string) => checks.push({ control, pass, detail });

      const s0 = c.getState();
      check("session open", !!s0.sessionId && !s0.ended, `id=${s0.sessionId} pages=${s0.pageCount}`);

      await c.play();
      await wait(1500);
      let s = c.getState();
      check("play", !s.paused && s.t > 0.5, `t=${s.t.toFixed(2)} paused=${s.paused} stage=${s.stageMode}`);
      c.pause();
      await wait(200);
      s = c.getState();
      const tPaused = s.t;
      check("pause", s.paused, `t=${s.t.toFixed(2)} paused=${s.paused}`);
      await wait(500);
      check("pause holds", Math.abs(c.getState().t - tPaused) < 0.01, `drift=${(c.getState().t - tPaused).toFixed(3)}s`);
      await c.play();
      await wait(800);
      s = c.getState();
      check("resume", !s.paused && s.t > tPaused, `t=${s.t.toFixed(2)} from ${tPaused.toFixed(2)}`);
      c.pause();

      // Five segment boundaries, spread over the lesson, both edges.
      const n = manifest.segments.length;
      const ks = n >= 5 ? [1, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1] : [];
      const seeks: Record<string, unknown>[] = [];
      for (const edge of ["start", "end"] as const) {
        for (const k of ks) {
          const r = await c.seekSegment(k, edge, manifest);
          seeks.push({ k, edge, target: r.target, landed: r.landed, errorMs: +r.errorMs.toFixed(1), latencyMs: +r.latencyMs.toFixed(1), pass: r.errorMs <= 150 });
          await wait(150);
        }
      }
      // A plain time seek, and a seek while playing.
      const plain = await c.seekMeasured(123.456);
      seeks.push({ k: "t", edge: "time", target: plain.target, landed: plain.landed, errorMs: +plain.errorMs.toFixed(1), latencyMs: +plain.latencyMs.toFixed(1), pass: plain.errorMs <= 150 });
      await c.play();
      await wait(400);
      const playingSeek = await c.seekMeasured(300);
      seeks.push({ k: "t", edge: "time-while-playing", target: playingSeek.target, landed: playingSeek.landed, errorMs: +playingSeek.errorMs.toFixed(1), latencyMs: +playingSeek.latencyMs.toFixed(1), pass: playingSeek.errorMs <= 150 });
      c.pause();

      // Land on a completed slide and freeze it.
      if (ks.length) await c.seekSegment(ks[1], "end", manifest);
      const before = c.getState().pageCount;
      await c.freeze();
      await wait(300);
      s = c.getState();
      check("freeze -> roll page +1", s.pageCount === before + 1, `pages ${before} -> ${s.pageCount}, stage=${s.stageMode}`);

      const bw = s.pageCount;
      c.openWorksheetPage();
      await wait(300);
      s = c.getState();
      check("worksheet page push", s.pageCount === bw + 1 && s.stageMode === "away", `pages ${bw} -> ${s.pageCount}, stage=${s.stageMode}`);

      const bb = s.pageCount;
      c.blankPage();
      await wait(600);
      s = c.getState();
      check("blank page", s.pageCount === bb + 1, `pages ${bb} -> ${s.pageCount}, on page ${s.page + 1}`);

      const p0 = s.page;
      c.pageUp();
      await wait(700);
      const pUp = c.getState().page;
      check("page up", pUp === p0 - 1, `page ${p0 + 1} -> ${pUp + 1}`);
      c.pageDown();
      await wait(700);
      const pDown = c.getState().page;
      check("page down", pDown === pUp + 1, `page ${pUp + 1} -> ${pDown + 1}`);

      const pagesAtEnd = c.getState().pageCount;
      await c.endSession();
      await wait(300);
      s = c.getState();
      check(
        "session close",
        s.ended && sink.closes.length === 1 && sink.closes[0] === pagesAtEnd,
        `ended=${s.ended} closes=${JSON.stringify(sink.closes)} rollPdf=${sink.uploads.filter((u) => u.type === "application/pdf").length}`,
      );

      const moves = s.moves;
      check(
        "every move logged as sk_move",
        moves.length > 0 && moves.length === sink.moves.length && moves.every((m) => m.kind === "sk_move" && m.ok),
        `${moves.length} moves, ${sink.moves.length} in sink, failed=${moves.filter((m) => !m.ok).length}`,
      );

      const out = {
        video: { duration: s.duration },
        seeks,
        checks,
        sink: {
          items: sink.items.map((i) => i.kind),
          syncs: sink.syncs,
          records: sink.records,
          uploads: sink.uploads,
          rollRecorded: sink.rollRecorded,
          closes: sink.closes,
          blockedApi: sink.blockedApi,
        },
        moves: moves.map((m) => ({ move: m.move, ok: m.ok, ms: Math.round(m.ms), result: m.result })),
      };
      window.__skM2!.last = out;
      setReport(JSON.stringify(out, null, 1));
      return out;
    };
    window.__skM2 = { run };
  }, [manifest, sink]);

  // Registered once the BoardSession has filled the ref.
  useEffect(() => {
    const id = setInterval(() => {
      if (ctl.current) {
        window.__skBoard = { controller: ctl.current, manifest, sink };
        clearInterval(id);
      }
    }, 50);
    return () => clearInterval(id);
  }, [manifest, sink]);

  return (
    <>
      <BoardSession
        session={SESSION}
        kit={kit}
        t={t}
        onEnd={() => {}}
        io={io}
        controllerRef={ctl}
        moveLogger={moveLogger}
      />
      {report && (
        <pre id="sk-m2-report" className="m-3 max-h-[40vh] overflow-auto rounded bg-black p-2 font-mono text-[10px] text-[#9FE]">
          {report}
        </pre>
      )}
    </>
  );
}
