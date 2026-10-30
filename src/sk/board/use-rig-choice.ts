"use client";

// React bindings for the tutor's look (founder, 2026-10-27) and the mic.
// useSyncExternalStore so the server render and the first client render agree
// (both see the default) and the remembered choice applies right after
// hydration — without a setState inside an effect.

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_RIG, RIG_CHOICE_KEY, readRigChoice, storeRigChoice, type RigChoice } from "./avatar";
import { micSupported } from "@/utils/assistant/voice-client";

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const serverRig = () => DEFAULT_RIG;

/** [the current look, choose(look)] — remembered per browser, default B. */
export function useRigChoice(): [RigChoice, (c: RigChoice) => void] {
  const rig = useSyncExternalStore(subscribe, readRigChoice, serverRig);
  const choose = useCallback((c: RigChoice) => {
    storeRigChoice(c);
    for (const fn of listeners) fn();
  }, []);
  return [rig, choose];
}

/** Forget this browser's stored look (the settings page's "delete what SK
 *  remembers"): every reader falls back to the default at once. */
export function forgetRigChoice(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(RIG_CHOICE_KEY);
  } catch {
    /* storage blocked */
  }
  for (const fn of listeners) fn();
}

const noop = () => () => {};
const serverMic = () => false;

/** Whether this browser can do push-to-talk (false on the server and at hydration). */
export function useMicSupported(): boolean {
  return useSyncExternalStore(noop, micSupported, serverMic);
}
