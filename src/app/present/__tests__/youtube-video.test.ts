// The Board's stage and its YouTube FALLBACK (founder 2026-10-30: "the
// quality matters in the app so lets use stored mp4 wherever possible"): the
// source the stage picks (the stored file whenever there is one), the
// server's per-lesson choice (signed MP4s first; a catalogue copy's YouTube
// ids only when it has none), captions off on the fallback player, and the
// IFrame player adapter behind the controller's VideoLike — seek with an
// asynchronous `seeked`, the time source, play/pause, ended and error.
// Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/youtube-video.test.ts
import { describe, expect, it } from "vitest";
import { captionsOff, stagePlayerEvents, stageSource, youtubePlayerVars, YouTubeVideo, YT_STATE, type YTPlayerLike } from "../youtube-video";
import { framesCapturable } from "../board-session";
import { lessonVideo } from "@/utils/catalogue/kit-youtube";

describe("stageSource", () => {
  it("the stored file wins over a YouTube id; YouTube only when there is no file; neither is nothing", () => {
    expect(stageSource("https://signed/lesson.mp4", "AAAAAAAAAA1")).toBe("file");
    expect(stageSource(null, "AAAAAAAAAA1")).toBe("youtube");
    expect(stageSource("", "AAAAAAAAAA1")).toBe("youtube");
    expect(stageSource("https://signed/lesson.mp4", null)).toBe("file");
    expect(stageSource(null, "bad id")).toBe("none");
    expect(stageSource(null, null)).toBe("none");
  });

  it("the player shows no YouTube chrome, plays inline, and loads no captions by default", () => {
    expect(youtubePlayerVars("https://sketchcast.app")).toMatchObject({ controls: 0, rel: 0, playsinline: 1, cc_load_policy: 0, origin: "https://sketchcast.app" });
  });
});

describe("freeze-frame and the slide stills (framesCapturable)", () => {
  it("come back on a lesson with a stored MP4, even when its kit is on YouTube; not on a YouTube-only fallback", () => {
    expect(framesCapturable({ urls: ["https://signed/lesson.mp4"] })).toBe(true);
    expect(framesCapturable({ urls: ["https://signed/lesson.mp4"], youtube: ["AAAAAAAAAA1"] })).toBe(true);
    expect(framesCapturable({ urls: [], youtube: ["AAAAAAAAAA1"] })).toBe(false);
    expect(framesCapturable(null)).toBe(false);
  });
});

describe("captions off on the fallback player", () => {
  const recorder = (fail = false) => {
    const calls: string[] = [];
    return {
      calls,
      unloadModule(name: string) {
        calls.push(`unload:${name}`);
        if (fail) throw new Error("no such module");
      },
      setOption(module: string, option: string, value: unknown) {
        calls.push(`set:${module}.${option}=${JSON.stringify(value)}`);
        if (fail) throw new Error("no such module");
      },
    };
  };

  it("unloads the captions module and clears the track", () => {
    const p = recorder();
    captionsOff(p);
    expect(p.calls).toEqual(["unload:captions", "unload:cc", "set:captions.track={}"]);
  });

  it("never throws: a player without the module, or without the methods, is left alone", () => {
    const p = recorder(true);
    expect(() => captionsOff(p)).not.toThrow();
    expect(p.calls).toHaveLength(3);
    expect(() => captionsOff({})).not.toThrow();
  });

  it("the stage's onReady turns captions off and hands the player to the adapter; a module load turns them off again", () => {
    const v = new YouTubeVideo(manualClock());
    const p = Object.assign(fakePlayer(7), recorder());
    const ev = stagePlayerEvents(v, () => p);
    expect(v.ready).toBe(false);
    ev.onReady();
    expect(p.calls).toContain("unload:captions");
    expect(v.ready).toBe(true);
    expect(v.currentTime).toBe(7);
    p.calls.length = 0;
    ev.onApiChange();
    expect(p.calls).toContain("unload:captions");
    // state and errors still reach the adapter
    let ended = 0;
    v.addEventListener("ended", () => ended++);
    ev.onStateChange({ data: YT_STATE.ENDED });
    expect(ended).toBe(1);
  });
});

describe("lessonVideo (the kit route's choice)", () => {
  const byKit = new Map([
    ["k-cells", ["AAAAAAAAAA1"]],
    ["k-two", ["BBBBBBBBBB1"]],
  ]);
  it("a catalogue copy with a stored MP4: the MP4, even though its kit is on YouTube", () => {
    expect(lessonVideo({ catalogue_ref: { topic_kit_id: "k-cells" } }, ["sys/lesson.mp4"], byKit)).toEqual({ youtube: [], paths: ["sys/lesson.mp4"] });
    expect(lessonVideo({ product_ref: { topic_kit_id: "k-two" } }, ["a.mp4", "a_part2.mp4"], byKit)).toEqual({ youtube: [], paths: ["a.mp4", "a_part2.mp4"] });
  });
  it("a catalogue copy with NO stored MP4: its kit's YouTube ids, the fallback", () => {
    expect(lessonVideo({ catalogue_ref: { topic_kit_id: "k-cells" } }, [], byKit)).toEqual({ youtube: ["AAAAAAAAAA1"], paths: [] });
    expect(lessonVideo({ catalogue_ref: { topic_kit_id: "k-none" } }, [], byKit)).toEqual({ youtube: [], paths: [] });
  });
  it("an uploaded book's lesson keeps its own storage video, and has no fallback", () => {
    expect(lessonVideo({ part: 1 }, ["mine/lesson.mp4"], byKit)).toEqual({ youtube: [], paths: ["mine/lesson.mp4"] });
    expect(lessonVideo({ part: 1 }, [], byKit)).toEqual({ youtube: [], paths: [] });
  });
});

function fakePlayer(start = 0) {
  const p = {
    t: start,
    state: YT_STATE.CUED as number,
    seeks: [] as number[],
    destroyed: false,
    playVideo() {
      p.state = YT_STATE.PLAYING;
    },
    pauseVideo() {
      p.state = YT_STATE.PAUSED;
    },
    seekTo(s: number) {
      p.seeks.push(s);
    },
    getCurrentTime: () => p.t,
    getDuration: () => 312,
    getPlayerState: () => p.state,
    destroy() {
      p.destroyed = true;
    },
  };
  return p satisfies YTPlayerLike;
}

function manualClock() {
  let q: { fn: () => void; id: number }[] = [];
  let n = 0;
  return {
    setTimeout: (fn: () => void) => (q.push({ fn, id: ++n }), n),
    clearTimeout: (h: unknown) => void (q = q.filter((x) => x.id !== h)),
    /** run everything queued now (and what that queues), up to a limit */
    flush(limit = 100) {
      for (let i = 0; i < limit && q.length; i++) q.shift()!.fn();
    },
    get pending() {
      return q.length;
    },
  };
}

describe("YouTubeVideo — the stage's VideoLike on a YouTube player", () => {
  it("is a time source: currentTime, duration, paused follow the player", async () => {
    const clock = manualClock();
    const v = new YouTubeVideo(clock);
    const p = fakePlayer(12.5);
    expect(v.paused).toBe(true);
    expect(Number.isNaN(v.duration)).toBe(true);
    v.attach(p);
    expect(v.currentTime).toBe(12.5);
    expect(v.duration).toBe(312);
    await v.play();
    expect(v.paused).toBe(false);
    v.pause();
    expect(v.paused).toBe(true);
  });

  it("a seek calls seekTo and emits `seeked` ASYNCHRONOUSLY once the player is near the target", () => {
    const clock = manualClock();
    const v = new YouTubeVideo(clock, { pollMs: 100, maxWaitMs: 3000 });
    const p = fakePlayer(0);
    v.attach(p);
    let seeked = 0;
    v.addEventListener("seeked", () => seeked++);
    v.currentTime = 42;
    expect(p.seeks).toEqual([42]);
    expect(seeked).toBe(0); // never in the same tick
    clock.flush(3); // the player has not moved yet: still polling
    expect(seeked).toBe(0);
    p.t = 41.8;
    clock.flush();
    expect(seeked).toBe(1);
    expect(v.currentTime).toBe(41.8);
  });

  it("a seek that never lands still emits `seeked` after the wait (the controller then reports where it is)", () => {
    const clock = manualClock();
    const v = new YouTubeVideo(clock, { pollMs: 100, maxWaitMs: 500 });
    v.attach(fakePlayer(0));
    let seeked = 0;
    v.addEventListener("seeked", () => seeked++);
    v.currentTime = 99;
    clock.flush();
    expect(seeked).toBe(1);
  });

  it("before the player is ready: a seek and a play are remembered and applied on attach", async () => {
    const clock = manualClock();
    const v = new YouTubeVideo(clock);
    v.currentTime = 30;
    await v.play();
    expect(v.currentTime).toBe(30);
    const p = fakePlayer(0);
    v.attach(p);
    expect(p.seeks).toEqual([30]);
    expect(p.state).toBe(YT_STATE.PLAYING);
  });

  it("ended and error reach their listeners; removeEventListener stops them; destroy tears the player down", () => {
    const v = new YouTubeVideo(manualClock());
    const p = fakePlayer();
    v.attach(p);
    const got: string[] = [];
    const onErr = () => got.push("error");
    v.addEventListener("ended", () => got.push("ended"));
    v.addEventListener("error", onErr);
    v.handleState(YT_STATE.ENDED);
    v.handleError();
    v.removeEventListener("error", onErr);
    v.handleError();
    expect(got).toEqual(["ended", "error"]);
    v.destroy();
    expect(p.destroyed).toBe(true);
    // a player that arrives after destroy is destroyed at once
    const late = fakePlayer();
    v.attach(late);
    expect(late.destroyed).toBe(true);
  });
});
