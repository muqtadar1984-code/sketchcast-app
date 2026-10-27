"use client";

// SK B2 harness — thin React shell over the board runtime (src/sk/board owns
// the DOM, the clock and the measurements) for the six prepared Chapter 2
// units. Loads graph → unit → segment + hit map, validates both, mounts the
// runtime in Option S mode, and renders controls (ABOVE the board: the Next
// dev-tools badge sits bottom-left), a summary panel and a log.

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { validateAside } from "@/sk/aside";
import { parseRigChoice, RIG_LABELS, rigBaseForChoice, type RigChoice } from "@/sk/board/avatar";
import { useRigChoice } from "@/sk/board/use-rig-choice";
import { hitTargets, validateHitMap, validateSegment, type HitMap, type OpentypeLike, type Segment } from "@/sk/board/engine";
import { SpikeRuntime, type PlayerState, type Rig } from "@/sk/board/runtime";
import { uuidv7 } from "@/sk/ids";
import { liveAsideFor, type S1Aside } from "./asides";
import { AutoHarness, parseAuto, readAuto, snapshot } from "./harness";

const GRAPH = "/sk-s1/ch02/graph.json";
type Graph = { units: { unit_key: string; title: string; assets: { kind: string; segment: string }[] }[] };
type Loaded = { unit: string; title: string; base: string; seg: Segment; hm: HitMap; font: OpentypeLike; rig: Rig | null; rigChoice: RigChoice; s1: S1Aside | null };
type Summary = ReturnType<SpikeRuntime["summary"]>;

const pct = (v: unknown) => {
  const p = v as { p50: number; p95: number; max: number; n: number } | undefined;
  return p && p.n ? `p50 ${Math.round(p.p50)} · p95 ${Math.round(p.p95)} · max ${Math.round(p.max)} (n=${p.n})` : "—";
};

export default function UnitPlayer() {
  const params = useSearchParams();
  const unit = params.get("unit") ?? "s1";
  const auto = parseAuto(params.get("auto"));
  // SK's look (founder, 2026-10-27): default B, remembered per browser;
  // `?rig=A|B` pins the look for a trial (the select is then read-only).
  const rigParam = params.get("rig");
  const [storedRig, chooseRig] = useRigChoice();
  const rig: RigChoice = rigParam ? parseRigChoice(rigParam) : storedRig;
  const hostRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const asideAudioRef = useRef<HTMLAudioElement>(null);
  const runtimeRef = useRef<SpikeRuntime | null>(null);
  const harnessRef = useRef<AutoHarness | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [state, setState] = useState<PlayerState | "loading">("loading");
  const [clockMs, setClockMs] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const say = useCallback((s: string) => setLog((l) => [...l.slice(-80), `${new Date().toLocaleTimeString()} ${s}`]), []);

  // 1. Load graph → unit → segment + hit map (+ font, rig, the S1 aside for s2).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const graph = (await fetch(GRAPH).then((r) => r.json())) as Graph;
        const u = graph.units.find((x) => x.unit_key === unit);
        if (!u) throw new Error(`unit ${unit} not in graph`);
        const rel = u.assets.find((a) => a.kind === "explain")?.segment ?? u.assets[0]!.segment;
        const base = "/sk-s1/ch02/" + rel.slice(0, rel.lastIndexOf("/") + 1);
        const [rawSeg, ot] = await Promise.all([fetch(base + "segment.json").then((r) => r.json() as Promise<Segment>), import("opentype.js")]);
        // The two gates: a manifest or a hit map that fails never reaches the DOM.
        const seg = validateSegment(rawSeg);
        const rawHm = (await fetch(base + (seg.hitmap ?? "hitmap.json")).then((r) => r.json())) as HitMap;
        const hm = validateHitMap(rawHm);
        const [rigData, font, s1] = await Promise.all([
          fetch(rigBaseForChoice(rig) + "rig.json").then((r) => (r.ok ? (r.json() as Promise<Rig>) : null)).catch(() => null),
          new Promise<OpentypeLike>((res, rej) => ot.load("/sk-s1/Caveat-Regular.ttf", (err, fnt) => (err || !fnt ? rej(err) : res(fnt as unknown as OpentypeLike)))),
          unit === "s2" ? fetch("/sk-s1/u4/segment.json").then((r) => r.json() as Promise<Segment>).then((s) => s.aside ?? null).catch(() => null) : Promise.resolve(null),
        ]);
        if (!alive) return;
        setLoaded({ unit, title: u.title, base, seg, hm, font, rig: rigData, rigChoice: rig, s1 });
        say(`loaded ${unit} "${u.title}": clip ${seg.clip?.duration_ms} ms, ${Object.keys(hm.elements).length} elements, ${hm.timeline.length} timeline entries, look ${rig}`);
      } catch (e) {
        say(`REFUSED ${unit}: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [unit, rig, say]);

  // 2. Mount the runtime once everything is here.
  useEffect(() => {
    const main = videoRef.current;
    if (!loaded || !hostRef.current || !main || !asideAudioRef.current) return;
    const rt = new SpikeRuntime(
      hostRef.current,
      main,
      asideAudioRef.current,
      loaded.seg,
      loaded.font,
      loaded.base,
      { state: setState, clock: setClockMs, log: say },
      { mode: "S", hitmap: loaded.hm, rig: loaded.rig ? { data: loaded.rig, base: rigBaseForChoice(loaded.rigChoice) } : undefined, checkpointKey: `sk-b2:${loaded.unit}:cursor` },
    );
    runtimeRef.current = rt;
    (window as unknown as { __skRuntime?: SpikeRuntime }).__skRuntime = rt; // dev page: lets a harness read measurements
    rt.mount();
    const id = setTimeout(() => setState("ready"), 0);
    const poll = setInterval(() => setSummary(rt.summary()), 500);
    return () => {
      clearTimeout(id);
      clearInterval(poll);
      harnessRef.current?.stop();
      rt.unmount();
      runtimeRef.current = null;
    };
  }, [loaded, say]);

  /** Barge-in: build the unit's live aside at the current clock, gate it, send
   * the command TWICE with one event id (the replay must be ignored). */
  const ask = useCallback(async () => {
    const rt = runtimeRef.current;
    if (!rt || !loaded || rt.state !== "playing") return;
    const aside = liveAsideFor(loaded.unit, loaded.hm, rt.t, loaded.s1);
    try {
      aside.program = validateAside({ tal: "0.2-aside", ...aside.program }, loaded.seg, hitTargets(loaded.hm));
    } catch (e) {
      say(`aside REFUSED by the gate: ${(e as Error).message}`);
      return;
    }
    const cmd = { eventId: uuidv7(), kind: "interrupt" as const, args: { aside } };
    const first = rt.command(cmd);
    const again = rt.command(cmd);
    if (!again.duplicate) say("REPLAY NOT IGNORED");
    await first.result;
  }, [loaded, say]);

  // 3. Auto trials (?auto=interrupt:20 | reload:10), resumed across reloads.
  useEffect(() => {
    const rt = runtimeRef.current;
    if (!rt || !loaded || state === "loading") return;
    if (harnessRef.current) return;
    const h = new AutoHarness(rt, loaded.unit, ask, say, (name) => (videoRef.current && hostRef.current ? snapshot(videoRef.current, hostRef.current, name) : Promise.resolve("")));
    harnessRef.current = h;
    const pending = readAuto();
    const resuming = pending && pending.unit === loaded.unit && pending.mode === "reload" && pending.done < pending.total ? pending : null;
    if (resuming) void h.continueReloads(resuming);
    else if (auto?.mode === "interrupt") void h.runInterrupts(auto.total);
    else if (auto?.mode === "reload") void h.continueReloads(null, auto.total);
    // One-shot: the harness object outlives state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, state]);

  // Space = ask (push-to-talk stand-in for the VAD).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && state === "playing") {
        e.preventDefault();
        void ask();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, ask]);

  const cmd = (kind: "play" | "pause" | "resume") => {
    const rt = runtimeRef.current;
    if (!rt) return;
    rt.command({ eventId: uuidv7(), kind, args: kind === "resume" ? { rewindMs: 0 } : undefined });
  };
  const download = () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const blob = new Blob([JSON.stringify({ ...rt.summary(), reloadResults: (window as unknown as { __skReloadResults?: unknown[] }).__skReloadResults ?? null }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sk-b2-${unit}-${Date.now()}.json`;
    a.click();
  };
  const snap = async () => {
    if (!videoRef.current || !hostRef.current) return;
    const name = `${unit}-${Math.round(clockMs / 1000)}s-${state}`;
    try {
      say(`snapshot → ${await snapshot(videoRef.current, hostRef.current, name)}`);
    } catch (e) {
      say(`snapshot failed: ${(e as Error).message}`);
    }
  };

  const s = summary as Record<string, unknown> | null;
  const busy = state === "loading" || state === "answering" || state === "listening";
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="card p-2">
        <audio ref={asideAudioRef} preload="auto" />
        <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
          <select className="h-9 px-2 border rounded" value={unit} onChange={(e) => (location.search = `?unit=${e.target.value}`)} disabled={state === "loading"}>
            {["s1", "s2", "s3", "s4", "s5", "s6"].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <select className="h-9 px-2 border rounded" value={rig} onChange={(e) => chooseRig(e.target.value === "A" ? "A" : "B")} disabled={state === "loading" || !!rigParam} title={rigParam ? "SK's look pinned by ?rig=" : "SK's look (default B)"} data-testid="sk-rig">
            {(["B", "A"] as RigChoice[]).map((c) => (
              <option key={c} value={c}>
                {RIG_LABELS[c]}
              </option>
            ))}
          </select>
          <button className="btn-primary h-9 px-3" onClick={() => cmd("play")} disabled={busy || state === "playing"}>
            ▶ Play
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => cmd("pause")} disabled={state !== "playing"}>
            ⏸ Pause
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => cmd("resume")} disabled={state !== "paused"}>
            ▶ Resume
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void ask()} disabled={state !== "playing"} title="Space">
            ✋ Ask
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => location.reload()} disabled={state === "loading"}>
            ⟳ Reload-test
          </button>
          <button className="h-9 px-3 border rounded" onClick={() => void snap()} disabled={state === "loading"}>
            📷 Snapshot
          </button>
          <button className="h-9 px-3 border rounded" onClick={download} disabled={state === "loading"}>
            ⤓ Measurements
          </button>
          <span className="text-xs text-[#667085]" data-testid="status">
            {unit} · {state} · {(clockMs / 1000).toFixed(1)} s / {((loaded?.seg.clip?.duration_ms ?? 0) / 1000).toFixed(1)} s
          </span>
        </div>
        <div className="relative w-full bg-white rounded overflow-hidden" style={{ aspectRatio: "16 / 9", maxHeight: "78vh", margin: "0 auto" }}>
          {loaded && <video ref={videoRef} src={loaded.base + (loaded.seg.clip?.uri ?? "clip.mp4")} preload="auto" playsInline className="absolute inset-0 w-full h-full" />}
          <div ref={hostRef} className="absolute inset-0 w-full h-full" data-testid="board" />
        </div>
      </div>
      <div className="grid gap-3 content-start">
        <div className="card p-3 text-xs" data-testid="summary">
          <div className="font-semibold mb-1">summary — {loaded?.title ?? unit}</div>
          <table className="w-full">
            <tbody>
              <tr><td className="pr-2 text-[#667085]">pause latency ms</td><td>{pct(s?.pauseLatencyMs)}</td></tr>
              <tr><td className="pr-2 text-[#667085]">drift ms (clip timeline)</td><td>{pct(s?.driftMs)}</td></tr>
              <tr><td className="pr-2 text-[#667085]">drift ms (live overlay)</td><td>{pct(s?.liveDriftMs)}</td></tr>
              <tr><td className="pr-2 text-[#667085]">interrupt → resume ok</td><td>{s ? `${(s.resume as { ok: number }).ok}/${(s.resume as { n: number }).n}` : "—"}</td></tr>
              <tr><td className="pr-2 text-[#667085]">reload recoveries ok</td><td>{s ? `${(s.reload as { ok: number }).ok}/${(s.reload as { n: number }).n}` : "—"}</td></tr>
              <tr><td className="pr-2 text-[#667085]">duplicates ignored</td><td>{s ? String(s.duplicatesIgnored) : "—"}</td></tr>
              <tr><td className="pr-2 text-[#667085]">point arrive ms</td><td>{pct((s?.gestures as Record<string, unknown> | undefined)?.point)}</td></tr>
              <tr><td className="pr-2 text-[#667085]">write hand→pen px</td><td>{pct((s?.gestures as Record<string, unknown> | undefined)?.writeHandPx)}</td></tr>
              <tr><td className="pr-2 text-[#667085]">listen pose ms</td><td>{pct((s?.gestures as Record<string, unknown> | undefined)?.listenMs)}</td></tr>
              <tr><td className="pr-2 text-[#667085]">fps (fronted pane only)</td><td>{s ? `avg ${Math.round((s.fps as { avg: number }).avg)} · min ${(s.fps as { min: number }).min} (n=${(s.fps as { n: number }).n})` : "—"}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="card p-3 text-xs font-mono overflow-auto" style={{ maxHeight: "48vh" }} data-testid="log">
          <div className="font-semibold mb-1">log</div>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
