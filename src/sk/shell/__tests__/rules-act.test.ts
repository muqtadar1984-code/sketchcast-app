/**
 * S2 slice A rules: the diary-note and parent-reminder phrasings (EN / MS / AR)
 * are `act`, never a navigate ("write in Ali's diary" names the diary), and the
 * model then resolves them through the action's capability. Questions and the
 * navigate phrasings they resemble keep their old routes.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/rules-act.test.ts
 */
import { describe, expect, it } from "vitest";
import { actPhraseOf, routeByRules } from "../rules";
import { NOW, makeCtx } from "./fixtures";

const ctx = makeCtx();
const clock = { day: 3, minutes: 990, iso: "2026-10-28T16:30:00+08:00" };
const route = (t: string) => routeByRules(t, ctx, NOW, clock);

describe("diary.note phrasings → act", () => {
  it.each([
    "post a notice to 7B: no school on Friday",
    "Post a note to 7B — bring your atlas tomorrow.",
    "send a message to 7C's parents: the trip is cancelled",
    "please post an announcement for 5 Amanah: sports day is on Saturday",
    "tell 7B to bring their atlas tomorrow",
    "tell 7B's parents the trip is on Friday",
    "add to the diary for 7B: homework is page 12",
    "write in Ali's diary that he did very well today",
    "put this in 7B's diary: library books due Monday",
    "send a reminder to 7B: the quiz is tomorrow",
    "tulis dalam diari 7B: tiada sekolah pada hari Jumaat",
    "maklumkan kepada 7B bahawa lawatan dibatalkan",
    "tolong hantar notis kepada 7B tentang hari sukan",
    "beritahu 7B bawa atlas esok",
    "اكتب في مذكرة 7B: لا توجد مدرسة يوم الجمعة",
    "انشر إشعارا للصف 7B عن الرحلة",
    "أخبر 7B بإحضار الأطلس غدا",
  ])("%s", (text) => {
    expect(route(text)).toEqual({ intent: "act", action: "diary.note" });
  });
});

describe("parents.remind phrasings → act", () => {
  it.each([
    "remind the parents of everyone who hasn't finished",
    "remind their parents",
    "Remind the parents of non-completers",
    "please remind all the parents in 7B who haven't done the worksheet",
    "send a reminder to the parents of the ones who haven't finished",
    "ingatkan ibu bapa murid yang belum siap",
    "tolong ingatkan ibubapa mereka",
    "hantar peringatan kepada ibu bapa yang belum siap",
    "ذكّر أولياء الأمور بمن لم ينهوا الواجب",
    "ذكر اولياء الامور",
  ])("%s", (text) => {
    expect(route(text)).toEqual({ intent: "act", action: "parents.remind" });
  });
});

describe("not an action", () => {
  it.each([
    ["open 7B's diary", "navigate"],
    ["show the diary for tomorrow", "navigate"],
    ["go to 7B's diary for today", "navigate"],
    ["diary", "navigate"],
    ["what did I post to 7B?", "ask"],
    ["did you remind the parents?", "ask"],
    ["tell me about 7B", "ask"],
    ["tell me who hasn't finished", "ask"],
    ["how many learners in 7B finished the worksheet?", "ask"],
    ["remind me what's next", "ask"],
  ])("%s → %s", (text, intent) => {
    expect(route(text).intent).toBe(intent);
  });
  it("a question is never an action, even phrased as one", () => {
    expect(actPhraseOf("post a notice to 7b", "post a notice to 7B?")).toBeNull();
    expect(actPhraseOf("remind the parents", "remind the parents؟")).toBeNull();
  });
});
