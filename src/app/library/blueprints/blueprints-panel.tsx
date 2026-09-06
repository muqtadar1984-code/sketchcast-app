"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BLUEPRINT_LIMITS,
  BLUEPRINT_PRESETS,
  BLUEPRINT_SCOPES,
  DIFFICULTIES,
  MIN_MATURITIES,
  composePlan,
  validateBlueprint,
  type Blueprint,
  type BlueprintInput,
  type Difficulty,
} from "@/utils/catalogue/questions";

// The blueprints screen's interactive half: the table (name, scope, the spec's
// fields, min maturity, status, uses), a create / edit form whose difficulty
// rows must add up to 1, and Retire / Reactivate. Every control POSTs
// /api/library/blueprints with {action, …} and then router.refresh(). The
// validator the route runs (validateBlueprint) runs here first so every
// problem shows before the round trip; the plan preview under the form is the
// composer's own arithmetic (composePlan), so a curator sees the buckets a
// preset will demand before saving it.

type Post = (payload: Record<string, unknown>, label: string) => Promise<Record<string, unknown> | null>;

function useBlueprintPost() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const post: Post = async (payload, label) => {
    setBusy(label);
    setError(null);
    setErrors([]);
    setNotice(null);
    const res = await fetch("/api/library/blueprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(null);
    if (!res.ok) {
      setError((json.error as string) ?? "Something went wrong.");
      if (Array.isArray(json.errors)) setErrors(json.errors.filter((e): e is string => typeof e === "string"));
      return null;
    }
    router.refresh();
    return json;
  };
  return { post, busy, error, errors, notice, setNotice };
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-[#E6F6F2] text-[#0F7A68]",
  retired: "bg-[#EEF0EC] text-[#5B6470]",
};

/** The form's state: strings, so a half-typed 0.4 is not coerced under the
 *  curator's fingers; validateBlueprint parses them on submit. */
type Draft = { name: string; scope: string; min_maturity: string; preset: string; objective_ratio: string; count: string; total_marks: string; mix: Record<Difficulty, string> };

const EMPTY_MIX: Record<Difficulty, string> = { "1": "", "2": "", "3": "", "4": "", "5": "" };

function draftOf(b: Blueprint | null): Draft {
  if (!b) return { name: "", scope: "worksheet", min_maturity: "basic", preset: "custom", objective_ratio: "0.5", count: "10", total_marks: "20", mix: { ...EMPTY_MIX, "2": "0.3", "3": "0.5", "4": "0.2" } };
  const mix = { ...EMPTY_MIX };
  for (const d of DIFFICULTIES) {
    const w = b.spec?.difficulty_mix?.[d];
    if (typeof w === "number" && w > 0) mix[d] = String(w);
  }
  return {
    name: b.name,
    scope: b.scope,
    min_maturity: b.min_maturity,
    preset: b.spec?.preset ?? "custom",
    objective_ratio: String(b.spec?.objective_ratio ?? 0.5),
    count: String(b.spec?.count ?? 10),
    total_marks: String(b.spec?.total_marks ?? 20),
    mix,
  };
}

/** What validateBlueprint parses: blanks in the mix are absent keys. */
function inputOf(d: Draft): unknown {
  const difficulty_mix: Record<string, number> = {};
  for (const k of DIFFICULTIES) if (d.mix[k].trim() !== "") difficulty_mix[k] = Number(d.mix[k]);
  return {
    name: d.name,
    scope: d.scope,
    min_maturity: d.min_maturity,
    spec: { preset: d.preset, objective_ratio: Number(d.objective_ratio), difficulty_mix, count: Number(d.count), total_marks: Number(d.total_marks) },
  };
}

const mixOf = (b: Blueprint) =>
  DIFFICULTIES.filter((d) => (b.spec?.difficulty_mix?.[d] ?? 0) > 0)
    .map((d) => `${d}: ${Math.round((b.spec.difficulty_mix[d] ?? 0) * 100)}%`)
    .join(" · ");

export function BlueprintsPanel({ blueprints, uses, canCurate }: { blueprints: Blueprint[]; uses: Record<string, number>; canCurate: boolean }) {
  const { post, busy, error, errors, notice, setNotice } = useBlueprintPost();
  const [editing, setEditing] = useState<null | { id: string | null }>(null); // null id = create

  const retire = async (b: Blueprint) => {
    if (!window.confirm(`Retire "${b.name}"? It leaves every Compose select; past sets keep pointing at it.`)) return;
    const r = await post({ action: "retire", blueprintId: b.id }, `retire-${b.id}`);
    if (r) setNotice(`"${b.name}" retired.`);
  };
  const reactivate = async (b: Blueprint) => {
    const r = await post({ action: "reactivate", blueprintId: b.id }, `reactivate-${b.id}`);
    if (r) setNotice(`"${b.name}" is active again.`);
  };

  return (
    <div className="space-y-4">
      {canCurate && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => setEditing(editing && editing.id === null ? null : { id: null })}
            className="btn-primary h-9 px-4 text-sm"
          >
            New blueprint
          </button>
        </div>
      )}
      {editing && editing.id === null && (
        <BlueprintForm
          key="new"
          initial={null}
          busy={busy === "create"}
          errors={errors}
          onCancel={() => setEditing(null)}
          onSave={async (blueprint) => {
            const r = await post({ action: "create", blueprint }, "create");
            if (r) {
              setEditing(null);
              setNotice(`"${blueprint.name}" created.`);
            }
          }}
        />
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[#0F7A68]">{notice}</p>}

      {blueprints.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-[#5B6470]">No blueprints yet — the 0112 seed ships twelve; create one above.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#5B6470] border-b border-[#EEF0EC]">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Preset</th>
                <th className="px-3 py-2 font-medium text-right">Items</th>
                <th className="px-3 py-2 font-medium text-right" title="share of objective items">
                  Objective
                </th>
                <th className="px-3 py-2 font-medium">Difficulty mix</th>
                <th className="px-3 py-2 font-medium text-right">Marks</th>
                <th className="px-3 py-2 font-medium">Needs</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Used</th>
                {canCurate && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF0EC]">
              {blueprints.map((b) => {
                const isEditing = editing?.id === b.id;
                return (
                  <Fragment key={b.id}>
                    <tr className={isEditing ? "bg-[#F4F6F3]" : b.status !== "active" ? "text-[#98A0A9]" : "hover:bg-[#F8FAF7]"}>
                      <td className="px-4 py-2 font-medium">{b.name}</td>
                      <td className="px-3 py-2">{b.scope.replace(/_/g, " ")}</td>
                      <td className="px-3 py-2">{b.spec?.preset ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular">{b.spec?.count ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular">{typeof b.spec?.objective_ratio === "number" ? `${Math.round(b.spec.objective_ratio * 100)}%` : "—"}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{mixOf(b) || "—"}</td>
                      <td className="px-3 py-2 text-right tabular">{b.spec?.total_marks ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{String(b.min_maturity).replace(/_/g, " ")}</td>
                      <td className="px-3 py-2">
                        <span className={`chip ${STATUS_TONE[b.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>{b.status}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular">{uses[b.id] ?? 0}</td>
                      {canCurate && (
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <button type="button" disabled={!!busy} onClick={() => setEditing(isEditing ? null : { id: b.id })} className="btn-ghost h-7 px-2">
                              {isEditing ? "Close" : "Edit"}
                            </button>
                            {b.status === "active" ? (
                              <button type="button" disabled={!!busy} onClick={() => void retire(b)} className="h-7 px-2 rounded-lg text-[#B3401F] hover:bg-[#FFE9E3]">
                                {busy === `retire-${b.id}` ? "…" : "Retire"}
                              </button>
                            ) : (
                              <button type="button" disabled={!!busy} onClick={() => void reactivate(b)} className="btn-ghost h-7 px-2">
                                {busy === `reactivate-${b.id}` ? "…" : "Reactivate"}
                              </button>
                            )}
                          </span>
                        </td>
                      )}
                    </tr>
                    {isEditing && (
                      // The form is a full-width row under the blueprint.
                      <tr className="bg-[#F8FAF7]">
                        <td colSpan={canCurate ? 11 : 10} className="px-4 py-3">
                          <BlueprintForm
                            initial={b}
                            busy={busy === "update"}
                            errors={errors}
                            onCancel={() => setEditing(null)}
                            onSave={async (blueprint) => {
                              const r = await post({ action: "update", blueprintId: b.id, blueprint }, "update");
                              if (r) {
                                setEditing(null);
                                setNotice(`"${blueprint.name}" saved — it applies to the next compose.`);
                              }
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BlueprintForm({
  initial,
  busy,
  errors,
  onSave,
  onCancel,
}: {
  initial: Blueprint | null;
  busy: boolean;
  errors: string[];
  onSave: (b: BlueprintInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(initial));
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const mixSum = DIFFICULTIES.reduce((n, k) => n + (d.mix[k].trim() === "" ? 0 : Number(d.mix[k]) || 0), 0);
  const live = validateBlueprint(inputOf(d));
  const plan = live.ok ? composePlan(live.blueprint.spec) : null;
  const shown = localErrors.length ? localErrors : errors;

  return (
    <form
      className={`${initial ? "" : "card p-5 "}space-y-3 text-sm`}
      onSubmit={async (e) => {
        e.preventDefault();
        const v = validateBlueprint(inputOf(d));
        if (!v.ok) {
          setLocalErrors(v.errors);
          return;
        }
        setLocalErrors([]);
        await onSave(v.blueprint);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block lg:col-span-2">
          <span className="text-xs text-[#5B6470]">Name (unique)</span>
          <input value={d.name} onChange={(e) => patch({ name: e.target.value })} maxLength={BLUEPRINT_LIMITS.name} required className="field h-9 w-full px-3 mt-1" />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Scope</span>
          <select value={d.scope} onChange={(e) => patch({ scope: e.target.value })} className="field h-9 w-full px-2 mt-1">
            {BLUEPRINT_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Needs bank maturity</span>
          <select value={d.min_maturity} onChange={(e) => patch({ min_maturity: e.target.value })} className="field h-9 w-full px-2 mt-1">
            {MIN_MATURITIES.map((m) => (
              <option key={m} value={m}>
                {m.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Preset</span>
          <select value={d.preset} onChange={(e) => patch({ preset: e.target.value })} className="field h-9 w-full px-2 mt-1">
            {BLUEPRINT_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Objective ratio (0–1)</span>
          <input value={d.objective_ratio} onChange={(e) => patch({ objective_ratio: e.target.value })} type="number" min={0} max={1} step={0.05} className="field h-9 w-full px-2 mt-1" />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Items (1–{BLUEPRINT_LIMITS.count_max})</span>
          <input value={d.count} onChange={(e) => patch({ count: e.target.value })} type="number" min={1} max={BLUEPRINT_LIMITS.count_max} className="field h-9 w-full px-2 mt-1" />
        </label>
        <label className="block">
          <span className="text-xs text-[#5B6470]">Total marks (1–{BLUEPRINT_LIMITS.total_marks_max})</span>
          <input value={d.total_marks} onChange={(e) => patch({ total_marks: e.target.value })} type="number" min={1} max={BLUEPRINT_LIMITS.total_marks_max} className="field h-9 w-full px-2 mt-1" />
        </label>
      </div>
      <div>
        <span className="text-xs text-[#5B6470]">
          Difficulty mix — weights that add up to 1 (now {Math.round(mixSum * 1000) / 1000}
          {Math.abs(mixSum - 1) > BLUEPRINT_LIMITS.mix_tolerance ? <span className="text-[#B3401F]"> — must be 1</span> : <span className="text-[#0F7A68]"> ✓</span>})
        </span>
        <div className="grid grid-cols-5 gap-2 mt-1">
          {DIFFICULTIES.map((k) => (
            <label key={k} className="block text-xs text-[#5B6470]">
              difficulty {k}
              <input value={d.mix[k]} onChange={(e) => patch({ mix: { ...d.mix, [k]: e.target.value } })} type="number" min={0} max={1} step={0.05} placeholder="0" className="field h-9 w-full px-2 mt-0.5" />
            </label>
          ))}
        </div>
      </div>
      {plan && (
        <p className="text-xs text-[#5B6470]">
          <span className="font-medium">Buckets the composer will fill:</span>{" "}
          {(["objective", "subjective"] as const)
            .map((mode) => {
              const parts = DIFFICULTIES.filter((k) => (plan[mode][k] ?? 0) > 0).map((k) => `d${k}×${plan[mode][k]}`);
              return parts.length ? `${mode}: ${parts.join(", ")}` : null;
            })
            .filter(Boolean)
            .join(" · ") || "none"}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="text-xs text-red-600 list-disc pl-5">
          {shown.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="btn-primary h-9 px-4">
          {busy ? "Saving…" : initial ? "Save" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="btn-ghost h-9 px-3">
          Cancel
        </button>
        {initial && <span className="text-xs text-[#9A6400]">A changed spec applies to the next compose; rendered sets are already files.</span>}
      </div>
    </form>
  );
}
