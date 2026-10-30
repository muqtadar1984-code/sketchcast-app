"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { LOOK_MIGRATED_LOCAL_KEY, MIGRATED_LOCAL_KEYS, PREF_KEYS, PREF_LOCAL_KEY, PREFS_MIGRATED_LOCAL_KEY, defaultsFor, localPrefValue, type SkPrefKey, type SkPrefs } from "@/sk/prefs";
import type { RigChoice } from "@/sk/board/avatar";
import { forgetRigChoice, useRigChoice } from "@/sk/board/use-rig-choice";

// The "SK & privacy" controls (SK S6 slice C). Every string arrives as a prop
// (the page holds the dictionary); every change goes through a route and the
// switch shows the SERVER's answer — optimistic, reverted on a failure.
// Touch-first: every control is a real button at least 44 px tall, with its
// one-line explanation always visible (nothing is hover-only).

export type PrivacyStrings = {
  skTitle: string;
  skIntro: string;
  prefsTitle: string;
  readAloud: string;
  readAloudHint: string;
  handsFree: string;
  handsFreeHint: string;
  suggestions: string;
  suggestionsHint: string;
  micOn: string;
  micOnHint: string;
  showText: string;
  showTextHint: string;
  character: string;
  characterHint: string;
  lookA: string;
  lookB: string;
  on: string;
  off: string;
  saving: string;
  saved: string;
  saveFailed: string;
  rememberTitle: string;
  rememberEmpty: string;
  rememberUnavailable: string;
  learningTitle: string;
  learningEmpty: string;
  deleteMine: string;
  deleteMineHint: string;
  deleteMineConfirm: string;
  deleteYes: string;
  cancel: string;
  deleted: string;
  deleteFailed: string;
  childrenTitle: string;
  childrenHint: string;
  childMemory: string;
  childMemoryHint: string;
  childVoice: string;
  childVoiceHint: string;
  deleteChild: string;
  deleteChildConfirm: string;
  schoolTitle: string;
  schoolSwitch: string;
  schoolSwitchHint: string;
  studentTitle: string;
};

export type SkPrivacyProps = {
  t: PrivacyStrings;
  role: string | null;
  prefs: SkPrefs;
  memoryReadable: boolean;
  workflow: Array<{ text: string; meta: string }>;
  learning: Array<{ text: string; meta: string }> | null;
  children: Array<{ id: string; name: string; transcripts: boolean; voice: boolean }>;
  school: { name: string; on: boolean; changed: string } | null;
  student: { memory: string; memoryOn: boolean; voice: string } | null;
};

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (w, k: string) => (k in vars ? vars[k] : w));

function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

async function send(url: string, method: "POST" | "DELETE", body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return res.ok;
  } catch {
    return false;
  }
}

function Switch({ id, label, hint, on, busy, onLabel, offLabel, onToggle }: { id: string; label: string; hint: string; on: boolean; busy: boolean; onLabel: string; offLabel: string; onToggle: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div id={`${id}-label`} className="font-medium">
          {label}
        </div>
        <p id={`${id}-hint`} className="text-sm text-[#5B6470] mt-0.5">
          {hint}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        disabled={busy}
        onClick={onToggle}
        className={`shrink-0 min-h-11 min-w-[4.5rem] px-3 rounded-full text-sm font-medium border transition-colors disabled:opacity-60 ${
          on ? "bg-[#0C8175] border-[#0C8175] text-white" : "bg-white border-[#CDD2CC] text-[#5B6470]"
        }`}
      >
        {on ? onLabel : offLabel}
      </button>
    </div>
  );
}

/** SK's character: two thumbnail radio buttons (native radios, so the arrow
 *  keys move between them), each at least 44 px tall. */
function LookChoice({ t, value, busy, onPick }: { t: PrivacyStrings; value: RigChoice; busy: boolean; onPick: (c: RigChoice) => void }) {
  const looks: Array<{ c: RigChoice; label: string; image: string }> = [
    { c: "A", label: t.lookA, image: "/sk/portrait/sk-a.webp" },
    { c: "B", label: t.lookB, image: "/sk/portrait/sk-b.webp" },
  ];
  return (
    <fieldset className="py-3" data-sk="look-choice" aria-describedby="pref-look-hint">
      <legend className="font-medium">{t.character}</legend>
      <p id="pref-look-hint" className="text-sm text-[#5B6470] mt-0.5">
        {t.characterHint}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        {looks.map(({ c, label, image }) => {
          const on = value === c;
          return (
            <label
              key={c}
              className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-full border py-1.5 ps-1.5 pe-4 text-sm transition-colors has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-[#0C8175]/40 ${
                on ? "border-[#0C8175] bg-[#E7F3F1] font-medium" : "border-[#CDD2CC] bg-white"
              } ${busy ? "opacity-60" : ""}`}
            >
              <input type="radio" name="sk-look" value={c} checked={on} disabled={busy} onChange={() => onPick(c)} className="sr-only" data-sk-look={c} />
              <Image src={image} alt="" width={40} height={40} unoptimized className={`h-10 w-10 rounded-full object-cover ring-2 ${on ? "ring-[#0C8175]" : "ring-transparent"}`} />
              <span>{label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Confirm({ text, yes, no, onYes, onNo, busy }: { text: string; yes: string; no: string; onYes: () => void; onNo: () => void; busy: boolean }) {
  return (
    <div role="alertdialog" aria-modal="false" aria-label={text} className="mt-3 rounded-lg border border-[#E8C4BE] bg-[#FDF5F3] p-4">
      <p className="text-sm mb-3">{text}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onYes} disabled={busy} className="min-h-11 px-4 rounded-md bg-[#B3261E] text-white text-sm font-medium disabled:opacity-60">
          {yes}
        </button>
        <button type="button" onClick={onNo} disabled={busy} className="min-h-11 px-4 rounded-md border border-[#CDD2CC] bg-white text-sm">
          {no}
        </button>
      </div>
    </div>
  );
}

export default function SkPrivacy(props: SkPrivacyProps) {
  const { t } = props;
  const router = useRouter();
  const [prefs, setPrefs] = useState<SkPrefs>(props.prefs);
  // SK's character reads the rig (the avatar's own source), not prefs.lookA:
  // the Shell's warm start applies the server's value to it.
  const [rig, chooseRig] = useRigChoice();
  const [children, setChildren] = useState(props.children);
  const [schoolOn, setSchoolOn] = useState(props.school?.on ?? false);
  const [workflow, setWorkflow] = useState(props.workflow);
  const [learning, setLearning] = useState(props.learning);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const say = (s: string) => setStatus(s);

  async function togglePref(k: SkPrefKey) {
    const next = !prefs[k];
    setPrefs((p) => ({ ...p, [k]: next }));
    setBusy(`pref:${k}`);
    say(t.saving);
    const ok = await send("/api/sk/prefs", "POST", { [k]: next });
    setBusy(null);
    if (!ok) {
      setPrefs((p) => ({ ...p, [k]: !next }));
      say(t.saveFailed);
      return;
    }
    // The panel's fast first paint follows the server's value; the server
    // already holds it, so this browser has nothing left to migrate.
    writeLocal(PREF_LOCAL_KEY[k], localPrefValue(k, next));
    writeLocal(PREFS_MIGRATED_LOCAL_KEY, "1");
    say(t.saved);
  }

  async function pickLook(next: RigChoice) {
    const prev = rig;
    if (next === prev) return;
    // The avatar (and the voice) change at once; reverted if the save fails.
    chooseRig(next);
    setBusy("pref:lookA");
    say(t.saving);
    const ok = await send("/api/sk/prefs", "POST", { lookA: next === "A" });
    setBusy(null);
    if (!ok) {
      chooseRig(prev);
      say(t.saveFailed);
      return;
    }
    // The server holds her look now: this browser's copy has nothing to migrate.
    writeLocal(LOOK_MIGRATED_LOCAL_KEY, "1");
    say(t.saved);
  }

  async function toggleConsent(childId: string, scope: "transcripts" | "voice") {
    const child = children.find((c) => c.id === childId);
    if (!child) return;
    const next = !child[scope];
    setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, [scope]: next } : c)));
    setBusy(`consent:${childId}:${scope}`);
    say(t.saving);
    const ok = await send("/api/sk/consent", "POST", { child: childId, scope, grant: next });
    setBusy(null);
    if (!ok) {
      setChildren((cs) => cs.map((c) => (c.id === childId ? { ...c, [scope]: !next } : c)));
      say(t.saveFailed);
      return;
    }
    say(t.saved);
  }

  async function toggleSchool() {
    const next = !schoolOn;
    setSchoolOn(next);
    setBusy("school");
    say(t.saving);
    const ok = await send("/api/sk/school-memory", "POST", { on: next });
    setBusy(null);
    if (!ok) {
      setSchoolOn(!next);
      say(t.saveFailed);
      return;
    }
    say(t.saved);
    // "Last changed by … on …" comes from the server.
    router.refresh();
  }

  async function deleteMine() {
    setBusy("delete:mine");
    const ok = await send("/api/sk/memory", "DELETE");
    setBusy(null);
    setConfirming(null);
    if (!ok) {
      say(t.deleteFailed);
      return;
    }
    setWorkflow([]);
    setLearning((l) => (l ? [] : l));
    // The preferences were workflow facts too: back to the defaults, here and
    // in the panel's local copy.
    setPrefs(defaultsFor(props.role));
    for (const k of PREF_KEYS) writeLocal(PREF_LOCAL_KEY[k], null);
    for (const m of MIGRATED_LOCAL_KEYS) writeLocal(m, null);
    // lookA's local copy is the rig's key (removed above): the avatar follows.
    forgetRigChoice();
    say(t.deleted);
  }

  async function deleteChild(childId: string) {
    setBusy(`delete:${childId}`);
    const ok = await send(`/api/sk/memory?child=${encodeURIComponent(childId)}`, "DELETE");
    setBusy(null);
    setConfirming(null);
    say(ok ? t.deleted : t.deleteFailed);
  }

  const isStudent = props.role === "student";
  const sw = (on: boolean) => ({ on, onLabel: t.on, offLabel: t.off });

  return (
    <section aria-labelledby="sk-privacy-title" className="space-y-6">
      <div>
        <h2 id="sk-privacy-title" className="text-2xl font-display">
          {t.skTitle}
        </h2>
        <p className="text-[#5B6470] mt-1">{t.skIntro}</p>
      </div>

      <p ref={statusRef} role="status" aria-live="polite" className="text-sm text-[#0C8175] min-h-5">
        {status}
      </p>

      <div data-tour="sk-prefs" className="card px-4 sm:px-5 py-2 divide-y divide-[#EEF0EC]">
        <h3 className="text-lg font-display pt-3 pb-1">{t.prefsTitle}</h3>
        <Switch id="pref-read" label={t.readAloud} hint={t.readAloudHint} {...sw(prefs.readAloud)} busy={busy === "pref:readAloud"} onToggle={() => void togglePref("readAloud")} />
        <Switch id="pref-hands" label={t.handsFree} hint={t.handsFreeHint} {...sw(prefs.handsFree)} busy={busy === "pref:handsFree"} onToggle={() => void togglePref("handsFree")} />
        <Switch id="pref-suggest" label={t.suggestions} hint={t.suggestionsHint} {...sw(prefs.suggestions)} busy={busy === "pref:suggestions"} onToggle={() => void togglePref("suggestions")} />
        <Switch id="pref-mic" label={t.micOn} hint={t.micOnHint} {...sw(prefs.micOn)} busy={busy === "pref:micOn"} onToggle={() => void togglePref("micOn")} />
        <Switch id="pref-text" label={t.showText} hint={t.showTextHint} {...sw(prefs.showText)} busy={busy === "pref:showText"} onToggle={() => void togglePref("showText")} />
        <LookChoice t={t} value={rig} busy={busy === "pref:lookA"} onPick={(c) => void pickLook(c)} />
      </div>

      {isStudent && props.student && (
        <div className="card px-4 sm:px-5 py-4">
          <h3 className="text-lg font-display mb-2">{t.studentTitle}</h3>
          <p className={props.student.memoryOn ? "" : "text-[#5B6470]"}>{props.student.memory}</p>
          <p className="text-sm text-[#5B6470] mt-2">{props.student.voice}</p>
        </div>
      )}

      <div data-tour="sk-memory" className="card px-4 sm:px-5 py-4">
        <h3 className="text-lg font-display mb-2">{t.rememberTitle}</h3>
        {!props.memoryReadable ? (
          <p className="text-sm text-[#5B6470]">{t.rememberUnavailable}</p>
        ) : workflow.length === 0 ? (
          <p className="text-sm text-[#5B6470]">{t.rememberEmpty}</p>
        ) : (
          <ul className="space-y-2">
            {workflow.map((r, i) => (
              <li key={i} className="text-sm">
                <span>{r.text}</span>
                {r.meta && <span className="block text-xs text-[#98A0A9]">{r.meta}</span>}
              </li>
            ))}
          </ul>
        )}

        {learning && (
          <div className="mt-5">
            <h4 className="font-medium mb-2">{t.learningTitle}</h4>
            {learning.length === 0 ? (
              <p className="text-sm text-[#5B6470]">{t.learningEmpty}</p>
            ) : (
              <ul className="space-y-2">
                {learning.map((r, i) => (
                  <li key={i} className="text-sm">
                    <span>{r.text}</span>
                    {r.meta && <span className="block text-xs text-[#98A0A9]">{r.meta}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-[#EEF0EC]">
          <button
            type="button"
            onClick={() => setConfirming("mine")}
            disabled={!!busy}
            className="min-h-11 px-4 rounded-md border border-[#B3261E] text-[#B3261E] text-sm font-medium bg-white disabled:opacity-60"
          >
            {t.deleteMine}
          </button>
          <p className="text-sm text-[#5B6470] mt-2">{t.deleteMineHint}</p>
          {confirming === "mine" && (
            <Confirm text={t.deleteMineConfirm} yes={t.deleteYes} no={t.cancel} busy={busy === "delete:mine"} onYes={() => void deleteMine()} onNo={() => setConfirming(null)} />
          )}
        </div>
      </div>

      {!isStudent && children.length > 0 && (
        <div data-tour="sk-children-consent" className="card px-4 sm:px-5 py-2">
          <h3 className="text-lg font-display pt-3">{t.childrenTitle}</h3>
          <p className="text-sm text-[#5B6470] pb-2">{t.childrenHint}</p>
          {children.map((c) => (
            <div key={c.id} className="border-t border-[#EEF0EC] py-2">
              <div className="font-medium pt-2">{c.name}</div>
              <Switch
                id={`mem-${c.id}`}
                label={fill(t.childMemory, { name: c.name })}
                hint={fill(t.childMemoryHint, { name: c.name })}
                {...sw(c.transcripts)}
                busy={busy === `consent:${c.id}:transcripts`}
                onToggle={() => void toggleConsent(c.id, "transcripts")}
              />
              <Switch
                id={`voice-${c.id}`}
                label={fill(t.childVoice, { name: c.name })}
                hint={fill(t.childVoiceHint, { name: c.name })}
                {...sw(c.voice)}
                busy={busy === `consent:${c.id}:voice`}
                onToggle={() => void toggleConsent(c.id, "voice")}
              />
              <div className="pb-2">
                <button
                  type="button"
                  onClick={() => setConfirming(`child:${c.id}`)}
                  disabled={!!busy}
                  className="min-h-11 px-4 rounded-md border border-[#B3261E] text-[#B3261E] text-sm font-medium bg-white disabled:opacity-60"
                >
                  {fill(t.deleteChild, { name: c.name })}
                </button>
                {confirming === `child:${c.id}` && (
                  <Confirm
                    text={fill(t.deleteChildConfirm, { name: c.name })}
                    yes={t.deleteYes}
                    no={t.cancel}
                    busy={busy === `delete:${c.id}`}
                    onYes={() => void deleteChild(c.id)}
                    onNo={() => setConfirming(null)}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {props.school && (
        <div data-tour="sk-school-switch" className="card px-4 sm:px-5 py-2">
          <h3 className="text-lg font-display pt-3">{t.schoolTitle}</h3>
          <Switch
            id="school-memory"
            label={fill(t.schoolSwitch, { school: props.school.name })}
            hint={fill(t.schoolSwitchHint, { school: props.school.name })}
            {...sw(schoolOn)}
            busy={busy === "school"}
            onToggle={() => void toggleSchool()}
          />
          <p className="text-xs text-[#98A0A9] pb-3">{props.school.changed}</p>
        </div>
      )}
    </section>
  );
}
