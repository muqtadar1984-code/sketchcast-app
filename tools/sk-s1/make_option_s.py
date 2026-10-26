"""SK S1 — Option S fixture: render unit U4 with the worker's SCENE ENGINE (the
production video renderer) to a clip, and export the HIT MAP the browser
overlay needs (every element's world box + when each action runs).

Same narration, same audio, same cue times as Option E (segment.json), so the
two options are compared on identical content. Element positions are world
pixels (1280×720); the illustration is bound first so the labels can be placed
from its REAL box rather than guessed.

Run with the worker venv:
  <worker>/.venv/Scripts/python.exe tools/sk-s1/make_option_s.py --worker <worker-master> --env <worker>/.env [--dry]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--worker", required=True)
ap.add_argument("--env", required=True)
ap.add_argument("--fixture", default=str(Path(__file__).resolve().parents[2] / "public" / "sk-s1" / "u4"))
ap.add_argument("--dry", action="store_true", help="bind + compile + hit map only; no frames")
args = ap.parse_args()

sys.path.insert(0, args.worker)
from dotenv import load_dotenv  # noqa: E402

load_dotenv(args.env)
os.environ.setdefault("RENDER_PROCESSES", "1")

from spike.scene_engine.encode import FPS, encode_scene  # noqa: E402
from spike.scene_engine.raster_assets import load_hand, make_resolver  # noqa: E402
from spike.scene_engine.render import SceneRenderer  # noqa: E402
from spike.scene_engine.schema import Scene  # noqa: E402

fx = Path(args.fixture)
seg = json.loads((fx / "segment.json").read_text(encoding="utf-8"))
audio_path = fx / "audio.mp3"
audio_secs = seg["audio"]["duration_ms"] / 1000.0
A = {a.get("id") or a["op"]: a for a in seg["actions"]}
asset = seg["assets"]["light_microscope"]
W, H = 1280, 720

# The resolver's ladder only considers keys that HAVE a prompt (a key without
# one is "no_prompt" → dropped). The prompt text is the library row's own
# description; allow_generate=False means it may only hydrate from the
# visual library / cache, never call the image model.
PROMPTS = {
    "light_microscope": "Side view of a light microscope, showing eyepiece lens, objective lens, nosepiece, "
                        "stage, stage clips, light source, coarse focus knob, fine focus knob, arm, base. "
                        "Name the layer groups exactly: eyepiece lens, objective lens, nosepiece, stage, "
                        "stage clips, light source, coarse focus knob, fine focus knob, arm, base",
}
resolver = make_resolver(PROMPTS, prefer_ai=True, allow_generate=False)
hand_loader = lambda k: load_hand(k)  # noqa: E731


def sec(ms: float) -> float:
    return round(ms / 1000.0, 3)


# ── pass 1: bind the illustration alone to learn its world box ───────────────
probe = Scene.model_validate({
    "id": "u4_probe", "narration": seg["narration"],
    "elements": [{"id": "mic", "type": "illustration", "asset": "light_microscope", "at": (300, 372), "scale": 1.0}],
    "actions": [{"verb": "draw", "target": "mic", "at": {"sec": 0.5}}],
})
pr = SceneRenderer(probe, asset_resolver=resolver, hand_loader=hand_loader)
b = pr.bound["mic"]
if b.raster is None and not b.layers:
    raise SystemExit("light_microscope did not resolve (visual library / cache)")
x0, y0, x1, y1 = b.box
print("probe box", b.box, "raster" if b.raster is not None else "vector")
# Fit the microscope to ~620 px tall, centred at x≈300 (left third), y centred.
want_h = 620.0
scale = want_h / max(1.0, (y1 - y0))
# re-bind at the chosen scale to get the real box
probe.elements[0].scale = scale
pr = SceneRenderer(probe, asset_resolver=resolver, hand_loader=hand_loader)
x0, y0, x1, y1 = pr.bound["mic"].box
print("mic box", (round(x0), round(y0), round(x1), round(y1)), "scale", round(scale, 3))
sx, sy = (x1 - x0) / asset["w"], (y1 - y0) / asset["h"]


def region_world(name: str) -> tuple[float, float, float, float]:
    boxes = asset["regions"][name]
    rx0 = min(bb[0] for bb in boxes); ry0 = min(bb[1] for bb in boxes)
    rx1 = max(bb[2] for bb in boxes); ry1 = max(bb[3] for bb in boxes)
    return (x0 + rx0 * sx, y0 + ry0 * sy, x0 + rx1 * sx, y0 + ry1 * sy)


eye = region_world("eyepiece lens")
obj = region_world("objective lens")
# The working column, world x. First render put it at 700 and "10 × 40 = 400"
# landed on the eyepiece label (which ends near x≈760) — the same lesson as
# Option E: the column must start past the labels' measured extent.
COL = 820.0

elements = [
    {"id": "mic", "type": "illustration", "asset": "light_microscope", "at": (300, 372), "scale": scale},
    {"id": "l1", "type": "text", "text": "eyepiece lens ×10", "at": (eye[2] + 70, (eye[1] + eye[3]) / 2), "role": "label", "size": 26, "anchor": "lm"},
    {"id": "a1", "type": "arrow", "tail": (eye[2] + 62, (eye[1] + eye[3]) / 2), "head": (eye[2] + 4, (eye[1] + eye[3]) / 2), "color": "muted"},
    {"id": "l2", "type": "text", "text": "objective lens ×40", "at": (obj[2] + 70, (obj[1] + obj[3]) / 2), "role": "label", "size": 26, "anchor": "lm"},
    {"id": "a2", "type": "arrow", "tail": (obj[2] + 62, (obj[1] + obj[3]) / 2), "head": (obj[2] + 4, (obj[1] + obj[3]) / 2), "color": "muted"},
    {"id": "w1", "type": "text", "text": "10 × 40 = 400", "at": (COL, 110), "role": "term", "size": 44, "anchor": "lm"},
    {"id": "w2", "type": "text", "text": "not 10 + 40", "at": (COL + 12, 165), "role": "caption", "size": 28, "color": "muted", "anchor": "lm"},
    {"id": "w3", "type": "text", "text": "M = image size ÷ actual size", "at": (COL, 270), "role": "term", "size": 32, "anchor": "lm"},
    # Rows end by y≈580 and x≈1120 so the SK rig (bottom-right, 26 % of the
    # frame tall → x ≈ 1140–1266, y ≈ 533–720) never covers the column.
    {"id": "w4", "type": "text", "text": "actual size = image size ÷ M", "at": (COL, 380), "role": "term", "size": 32, "anchor": "lm"},
    {"id": "w5", "type": "text", "text": "image = 48 mm,  M = ×800", "at": (COL, 440), "role": "label", "size": 30, "anchor": "lm"},
    {"id": "w6", "type": "text", "text": "48 ÷ 800 = 0.06 mm", "at": (COL, 500), "role": "term", "size": 32, "anchor": "lm"},
    {"id": "w7", "type": "text", "text": "0.06 × 1000 = 60 µm", "at": (COL, 560), "role": "term", "size": 32, "anchor": "lm"},
]
actions = [
    {"verb": "draw", "target": "mic", "at": {"sec": sec(A["r1"]["t"])}, "duration": min(30.0, sec(A["r1"]["dur"]))},
    {"verb": "draw", "target": "a1", "at": {"sec": sec(A["l1"]["t"])}, "duration": 0.5},
    {"verb": "write", "target": "l1", "at": {"sec": sec(A["l1"]["t"] + 400)}, "duration": 0.6},
    {"verb": "draw", "target": "a2", "at": {"sec": sec(A["l2"]["t"])}, "duration": 0.5},
    {"verb": "write", "target": "l2", "at": {"sec": sec(A["l2"]["t"] + 400)}, "duration": 0.6},
    {"verb": "write", "target": "w1", "at": {"sec": sec(A["w1"]["t"])}, "duration": sec(A["w1"]["dur"])},
    {"verb": "write", "target": "w2", "at": {"sec": sec(A["w2"]["t"])}, "duration": sec(A["w2"]["dur"])},
    {"verb": "highlight", "target": "w2", "at": {"sec": sec(A["h1"]["t"])}, "duration": 0.6},
    {"verb": "write", "target": "w3", "at": {"sec": sec(A["w3"]["t"])}, "duration": sec(A["w3"]["dur"])},
    {"verb": "write", "target": "w4", "at": {"sec": sec(A["w4"]["t"])}, "duration": sec(A["w4"]["dur"])},
    {"verb": "write", "target": "w5", "at": {"sec": sec(A["w5"]["t"])}, "duration": sec(A["w5"]["dur"])},
    {"verb": "write", "target": "w6", "at": {"sec": sec(A["w6"]["t"])}, "duration": sec(A["w6"]["dur"])},
    {"verb": "write", "target": "w7", "at": {"sec": sec(A["w7"]["t"])}, "duration": sec(A["w7"]["dur"])},
    {"verb": "circle", "target": "w7", "at": {"sec": sec(A["h2"]["t"])}, "duration": 0.7},
]
scene = Scene.model_validate({
    "id": "u4_option_s", "scene_type": "worked_example", "narration": seg["narration"],
    "style": {"pen_mode": "hand", "hand_scale": 0.8},
    "elements": elements, "actions": actions,
})

t0 = time.time()
r = SceneRenderer(scene, asset_resolver=resolver, hand_loader=hand_loader)
r.compile(audio_secs)
total = r.total_secs(audio_secs)
warnings = [w for w in getattr(r, "warnings", [])] if hasattr(r, "warnings") else []
print("compiled: total", round(total, 2), "s; timeline", len(r.timeline), "warnings", warnings[:8])

# ── the hit map (what the overlay + avatar need) ─────────────────────────────
hit = {
    "world": {"w": W, "h": H},
    "fps": FPS,
    "duration_ms": round(total * 1000),
    "elements": {eid: {"box": [round(v, 1) for v in r.bound[eid].box]} for eid in r.bound},
    "asset": {"mic": {"box": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)],
                      "regions": {k: [round(v, 1) for v in region_world(k)] for k in asset["regions"]}}},
    "timeline": [{"target": ta.action.target, "verb": getattr(ta.action, "verb", "?"),
                  "start_ms": round(ta.start * 1000), "end_ms": round(ta.end * 1000)} for ta in r.timeline],
}
(fx / "optionS.hitmap.json").write_text(json.dumps(hit, indent=1), encoding="utf-8")
print("hit map written;", json.dumps(hit["timeline"][:6]))

if args.dry:
    raise SystemExit(0)

out = fx / "optionS.mp4"
ok = encode_scene(r.frames(audio_secs, FPS), total, str(audio_path), out, FPS)
print("encode", "ok" if ok else "FAILED", out, round(out.stat().st_size / 1e6, 2) if out.exists() else None, "MB", "render wall", round(time.time() - t0, 1), "s")
