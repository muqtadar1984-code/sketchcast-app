"""SK S1 fixture builder — unit U4 "Total magnification" (Biology ch.2, §s5).

Produces everything the spike player needs, offline, with the worker's own
tools so the spike measures the REAL pipeline, not a mock:

  public/sk-s1/u4/audio.mp3         Edge TTS narration (free; exact word marks)
  public/sk-s1/u4/aside1.mp3        a canned live answer for the interrupt test
  public/sk-s1/u4/light_microscope.png   the production ink asset (visual_assets)
  public/sk-s1/u4/segment.json      the segment manifest (docs/SK-CONTRACTS.md §3.2)
                                     with every action's time ALREADY resolved
                                     against the measured word marks — what
                                     ERE's schedule() hands a renderer.

Run with the worker venv (it has edge_tts, numpy, PIL, supabase, dotenv):
  <worker>/.venv/Scripts/python.exe tools/sk-s1/make_fixture.py --worker <worker-master-checkout> --env <worker>/.env

Every narration sentence is taken from ch02-draft.json §s5 (the approved
chapter text) — the spike must not invent science.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--worker", required=True, help="worker checkout at origin/master (for shared.tts + scene_engine.trace)")
ap.add_argument("--env", required=True, help=".env with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "public" / "sk-s1" / "u4"))
ap.add_argument("--voice", default="edge-aria")
ap.add_argument("--skip-audio", action="store_true")
args = ap.parse_args()

sys.path.insert(0, args.worker)
from dotenv import load_dotenv  # noqa: E402

load_dotenv(args.env)
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

# ── 1. The production microscope asset + its drawing order ───────────────────
ASSET_ID = "c0cf7bbe-94ae-4302-aaa0-74298b8c92da"
ASSET_PATH = "generated/light_microscope/091e0d722a3ad5f9.png"
png = out / "light_microscope.png"
if not png.exists():
    from supabase import create_client

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    png.write_bytes(sb.storage.from_("visual-assets").download(ASSET_PATH))
    print("downloaded", png, png.stat().st_size, "bytes")

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from spike.scene_engine.trace import drawing_order  # noqa: E402

im = Image.open(png)
if im.mode != "RGBA":
    from spike.scene_engine.raster_assets import to_ink  # noqa: E402

    im = to_ink(im)
alpha = np.asarray(im.getchannel("A"))
trace = drawing_order(alpha)
W, H = im.size
print("asset", W, H, "trace points", len(trace))

# Regions as stored in visual_assets.vision (asset pixel boxes).
REGIONS = {
    "arm": [[11.067, 164.512, 249.798, 734.368]],
    "base": [[23.188, 701.296, 516.46, 834.432]],
    "stage": [[173.383, 463.008, 514.879, 562.224]],
    "nosepiece": [[302.498, 291.712, 449.531, 383.296]],
    "stage clips": [[249.271, 456.224, 389.98, 481.664], [198.152, 502.864, 349.401, 530.848]],
    "light source": [[307.768, 638.544, 393.142, 727.584]],
    "eyepiece lens": [[294.066, 12.72, 376.805, 145.856]],
    "objective lens": [[314.619, 361.248, 363.103, 438.416], [364.684, 306.976, 431.086, 430.784], [413.695, 311.216, 485.894, 390.928]],
    "fine focus knob": [[67.983, 561.376, 168.113, 658.896], [174.437, 646.176, 220.813, 701.296]],
    "coarse focus knob": [[212.908, 184.864, 287.215, 266.272]],
}

# ── 2. Narration (sentences from ch02 §s5) ───────────────────────────────────
NARRATION = (
    "Let's work out magnification. "
    "A microscope makes an image bigger than the real thing. "
    "Magnification tells you how many times larger the image appears than the real object. "
    "It has no unit, and it is written with a multiplication sign, for example times four hundred. "
    "The eyepiece lens has its own magnification, often times ten. "
    "So does the objective lens, for example times forty. "
    "The two lenses work together, so their magnifications are multiplied. "
    "Ten times forty gives four hundred. "
    "Not fifty: the two magnifications are multiplied, never added. "
    "You can also work out the magnification of a drawing or photograph. "
    "Magnification equals image size divided by actual size. "
    "Rearranged, actual size equals image size divided by magnification. "
    "Here is one. "
    "A student's drawing of a cheek cell is forty-eight millimetres wide, and the magnification of the drawing is times eight hundred. "
    "Forty-eight divided by eight hundred is nought point nought six millimetres. "
    "Cells are so small that their actual size is better given in micrometres. "
    "One millimetre is one thousand micrometres, so multiply by one thousand. "
    "The cell is sixty micrometres wide."
)
ASIDE = "Yes. The eyepiece is the lens you look through, at the very top of the microscope. Its magnification is written on it, here times ten."


def synth(text: str, mp3: Path, words_json: Path) -> list[dict]:
    if args.skip_audio and mp3.exists() and words_json.exists():
        return json.loads(words_json.read_text(encoding="utf-8"))
    from shared.tts import synthesize  # noqa: E402

    rep: dict = {}
    synthesize(text, mp3, args.voice, boundaries_out=words_json, report=rep)
    print("tts", mp3.name, rep)
    return json.loads(words_json.read_text(encoding="utf-8"))


raw_words = synth(NARRATION, out / "audio.mp3", out / "audio.words.json")
raw_aside = synth(ASIDE, out / "aside1.mp3", out / "aside1.words.json")


def norm_words(raw: list[dict]) -> list[dict]:
    """Edge boundaries → contract Marks.words: [{i,t0,t1,text}] in ms."""
    ws = []
    for i, w in enumerate(raw):
        t0 = float(w.get("t", 0.0)) * 1000.0
        d = w.get("d")
        text = str(w.get("w") or w.get("text") or "")
        t1 = (t0 + float(d) * 1000.0) if d is not None else None
        ws.append({"i": i, "t0": round(t0), "t1": t1, "text": text})
    for i, w in enumerate(ws):
        if w["t1"] is None:
            w["t1"] = ws[i + 1]["t0"] if i + 1 < len(ws) else w["t0"] + 300
        w["t1"] = round(w["t1"])
    return ws


words = norm_words(raw_words)
aside_words = norm_words(raw_aside)


def mp3_duration_ms(p: Path) -> int:
    try:
        from mutagen.mp3 import MP3  # type: ignore

        return int(MP3(str(p)).info.length * 1000)
    except Exception:
        return 0


def find_word(ws: list[dict], token: str, nth: int = 1) -> dict:
    """The nth word whose normalised text starts with `token` (case-insensitive)."""
    t = token.lower()
    n = 0
    for w in ws:
        if re.sub(r"[^a-z0-9']", "", w["text"].lower()).startswith(t):
            n += 1
            if n == nth:
                return w
    raise SystemExit(f"cue word not found: {token!r} #{nth}")


def wi(i: int, expect: str) -> dict:
    """Word by index, asserting its text — the cue table below is pinned to the
    narration's tokenisation so a silent re-tokenisation can't shift a cue."""
    w = words[i]
    if not re.sub(r"[^a-z0-9'-]", "", w["text"].lower()).startswith(expect.lower()):
        raise SystemExit(f"word {i} is {w['text']!r}, expected {expect!r} — narration/tokenisation changed; re-pin the cues")
    return w


def at(i: int, expect: str) -> int:
    return wi(i, expect)["t0"]


def end_of(i: int, expect: str) -> int:
    return wi(i, expect)["t1"]


# ── 3. The board program — TAL v0.2 shapes, times resolved (ms) ──────────────
# Board is ERE's 0–100 logical square. The microscope sits left; the working
# column is on the right. Asset aspect 527:848 → height 72 ⇒ width 44.7.
# Layout (first run showed "10 × 40 = 400" written over the eyepiece label):
# microscope x 3–41.5, y 20–82; labels to its right end by x≈58 (eyepiece,
# y≈27) and x≈62 (objective, y≈47); the working column starts at x=50 and uses
# the rows those labels leave free; the avatar head sits at (90, 90).
MIC = {"x": 3.0, "y": 20.0, "w": 62.0 * W / H, "h": 62.0}
COL_X = 50.0

# Cue table: (word index, expected token) pinned to the Edge tokenisation of
# NARRATION (183 words). `wi` refuses to build if a token moved.
T_MIC, T_OBJECT = at(5, "microscope"), end_of(27, "object")
T_EYE, T_OBJ = at(46, "eyepiece"), at(58, "objective")
T_W1, T_W1E = at(74, "ten"), end_of(79, "hundred")
T_NOT, T_NEVER = at(80, "not"), at(87, "never")
T_W3, T_W3E = at(101, "magnification"), end_of(108, "size")
T_W4, T_W4E = at(109, "rearranged"), end_of(117, "magnification")
T_W5, T_W5E = at(129, "forty-eight"), end_of(141, "hundred")
T_W6, T_W6E = at(142, "forty-eight"), end_of(152, "millimetres")
T_W7, T_W7E = at(173, "multiply"), end_of(181, "micrometres")
T_SIXTY = at(180, "sixty")

actions = [
    {"op": "place", "as": "mic", "ref": "asset:light_microscope", "at": MIC, "t": 0},
    {"op": "reveal", "id": "r1", "target": "mic", "order": "stroke", "t": T_MIC, "dur": max(4000, T_OBJECT - T_MIC)},
    {"op": "label", "id": "l1", "target": "mic.eyepiece lens", "text": "eyepiece lens ×10", "side": "right", "t": T_EYE, "dur": 900},
    {"op": "label", "id": "l2", "target": "mic.objective lens", "text": "objective lens ×40", "side": "right", "t": T_OBJ, "dur": 900},
    {"op": "write", "id": "w1", "text": "10 × 40 = 400", "at": {"x": COL_X, "y": 14}, "size": 6.0, "t": T_W1, "dur": T_W1E - T_W1},
    {"op": "write", "id": "w2", "text": "not 10 + 40", "at": {"x": COL_X + 2, "y": 21}, "size": 4.0, "style": "muted", "t": T_NOT, "dur": 1500},
    {"op": "highlight", "id": "h1", "target": "w2", "style": "strike", "t": T_NEVER, "dur": 500},
    {"op": "write", "id": "w3", "text": "M = image size ÷ actual size", "at": {"x": COL_X, "y": 37}, "size": 4.2, "t": T_W3, "dur": T_W3E - T_W3},
    {"op": "write", "id": "w4", "text": "actual size = image size ÷ M", "at": {"x": COL_X, "y": 57}, "size": 4.2, "t": T_W4, "dur": T_W4E - T_W4},
    {"op": "write", "id": "w5", "text": "image = 48 mm,  M = ×800", "at": {"x": COL_X, "y": 65}, "size": 4.4, "t": T_W5, "dur": T_W5E - T_W5},
    {"op": "write", "id": "w6", "text": "48 ÷ 800 = 0.06 mm", "at": {"x": COL_X, "y": 73}, "size": 5.0, "t": T_W6, "dur": T_W6E - T_W6},
    {"op": "write", "id": "w7", "text": "0.06 × 1000 = 60 µm", "at": {"x": COL_X, "y": 81}, "size": 5.0, "t": T_W7, "dur": T_W7E - T_W7},
    {"op": "highlight", "id": "h2", "target": "w7", "style": "circle", "t": T_W7E + 100, "dur": 700},
]
for a in actions:
    assert a.get("dur", 1) > 0, a
gestures = [
    {"t": T_MIC, "kind": "point", "target": "mic"},
    {"t": T_EYE, "kind": "point", "target": "mic.eyepiece lens"},
    {"t": T_OBJ, "kind": "point", "target": "mic.objective lens"},
    *[{"t": a["t"], "kind": "write", "target": a["id"], "until": a["t"] + a["dur"]} for a in actions if a["op"] == "write"],
    {"t": T_SIXTY, "kind": "point", "target": "w7"},
]
aside_actions = [
    {"op": "highlight", "id": "a1", "target": "mic.eyepiece lens", "style": "circle", "t": find_word(aside_words, "eyepiece")["t0"], "dur": 600},
    {"op": "label", "id": "a2", "target": "mic.eyepiece lens", "text": "×10", "side": "right", "t": find_word(aside_words, "ten")["t0"], "dur": 600},
]

segment = {
    "segment_id": "u4-explain-main-s1",
    "asset_id": "spike",
    "version": 1,
    "language": "en",
    "voice": args.voice,
    "audio": {"uri": "audio.mp3", "duration_ms": mp3_duration_ms(out / "audio.mp3") or words[-1]["t1"] + 600},
    "marks": {"words": words, "visemes": []},
    "assets": {
        "light_microscope": {
            "src": "light_microscope.png",
            "w": W,
            "h": H,
            "regions": REGIONS,
            "trace": [[round(x, 1), round(y, 1)] for x, y in trace],
            "source": {"visual_asset_id": ASSET_ID, "storage_path": ASSET_PATH},
        }
    },
    "actions": actions,
    "gestures": gestures,
    "aside": {
        "question": "Is the eyepiece the top lens?",
        "audio": {"uri": "aside1.mp3", "duration_ms": mp3_duration_ms(out / "aside1.mp3") or aside_words[-1]["t1"] + 600},
        "marks": {"words": aside_words, "visemes": []},
        "actions": aside_actions,
        "gestures": [{"t": 0, "kind": "point", "target": "mic.eyepiece lens"}],
    },
    "origin": "prepared",
    "checkpoints": [0] + [a["t"] for a in actions if a["op"] in ("write", "label", "reveal")],
    "narration": NARRATION,
}
(out / "segment.json").write_text(json.dumps(segment, ensure_ascii=False, indent=1), encoding="utf-8")
print("wrote", out / "segment.json", "actions", len(actions), "words", len(words), "duration", segment["audio"]["duration_ms"], "ms")
