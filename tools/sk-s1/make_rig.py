"""SK rigs from the chosen characters. One generated illustration → three
cut-out layers the browser animates:

  body.png   everything except the head and the pointing forearm
  head.png   hair/scarf to chin (+ a little neck), pivots at the neck → tilt / nod
  arm.png    pointing forearm + hand, pivots at the elbow → aims at targets

plus rig.json with the pivots, mouth and eye positions (source pixels) and
whether the figure is mirrored so it points LEFT (SK stands bottom-right, the
board is to her left). The white background becomes transparent with a
BORDER flood (not a luminance cut — pale skin and white shirts would vanish).

  python tools/sk-s1/make_rig.py <character> <source.png> public/sk-s1/sk-<x>

Characters: B (Indian man, glasses — male voices), A (Malay woman, tudung —
female voices).
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# Regions in source pixels, chosen per image and checked by eye on the sheet.
CHARACTERS = {
    "B": {
        "label": "Indian man teacher, glasses (male voices)",
        "flip": False,  # already points to the viewer's left
        "head": {"x0": 350, "y0": 80, "x1": 640, "y1": 478},  # chin ≈ 470; the collar stays on the body
        "neck": (492, 476),
        "arm": {"x0": 40, "y0": 455, "x1": 345, "y1": 850},  # elbow crease (incl. the rolled cuff) → fingertip
        "elbow": (336, 802),
        "fingertip": (78, 482),
        "mouth": {"cx": 482, "cy": 392, "w": 74, "h": 22},
        "eyes": [{"cx": 452, "cy": 296, "w": 44, "h": 26}, {"cx": 528, "cy": 296, "w": 44, "h": 26}],
        "skin": "#C98A5E", "lip": "#7A2E2E",
    },
    "A": {
        "label": "Malay woman teacher, teal tudung (female voices)",
        "flip": True,  # drawn pointing to the viewer's right → mirrored to point left
        # The tudung drapes over the shoulders; the head layer keeps the whole
        # scarf so the drape never splits. Tilt angles stay small (≤ 9°).
        "head": {"x0": 170, "y0": 70, "x1": 545, "y1": 565},
        "neck": (365, 500),
        "arm": {"x0": 560, "y0": 400, "x1": 850, "y1": 690},  # raised forearm from the elbow → fingertip
        "elbow": (632, 655),
        "fingertip": (828, 432),
        "mouth": {"cx": 392, "cy": 374, "w": 60, "h": 20},
        "eyes": [{"cx": 334, "cy": 286, "w": 42, "h": 24}, {"cx": 452, "cy": 286, "w": 42, "h": 24}],
        "skin": "#D9A27A", "lip": "#8A3A3A",
    },
}

which, src, out = sys.argv[1].upper(), Path(sys.argv[2]), Path(sys.argv[3])
C = CHARACTERS[which]
out.mkdir(parents=True, exist_ok=True)

im = Image.open(src).convert("RGB")
W, H = im.size
flood = im.copy()
for seed in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1), (W // 2, 0), (W // 2, H - 1)]:
    ImageDraw.floodfill(flood, seed, (255, 0, 255), thresh=40)
arr = np.asarray(flood)
bg = (arr[..., 0] == 255) & (arr[..., 1] == 0) & (arr[..., 2] == 255)
alpha = np.where(bg, 0, 255).astype(np.uint8)
rgba = np.dstack([np.asarray(im), alpha])
ys, xs = np.nonzero(alpha)
print(which, "size", W, H, "opaque bbox", xs.min(), ys.min(), xs.max(), ys.max())


def box_mask(b):
    m = np.zeros((H, W), bool)
    m[b["y0"]:b["y1"], b["x0"]:b["x1"]] = True
    return m


head_m = box_mask(C["head"]) & (alpha > 0)
arm_m = box_mask(C["arm"]) & (alpha > 0)
body_m = (alpha > 0) & ~head_m & ~arm_m


def save(mask, name, box):
    layer = rgba.copy()
    layer[..., 3] = np.where(mask, 255, 0)
    crop = Image.fromarray(layer).crop((box["x0"], box["y0"], box["x1"], box["y1"]))
    crop.save(out / name, optimize=True)
    print(name, crop.size)


full = {"x0": int(xs.min()), "y0": int(ys.min()), "x1": int(xs.max()) + 1, "y1": int(ys.max()) + 1}
save(body_m, "body.png", full)
save(head_m, "head.png", C["head"])
save(arm_m, "arm.png", C["arm"])
rig = {
    "character": which, "label": C["label"], "source": src.name, "w": W, "h": H, "frame": full, "flip": C["flip"],
    "body": full, "head": {**C["head"], "pivot": C["neck"]}, "arm": {**C["arm"], "pivot": C["elbow"], "fingertip": C["fingertip"]},
    "mouth": C["mouth"], "eyes": C["eyes"], "skin": C["skin"], "lip": C["lip"],
}
(out / "rig.json").write_text(json.dumps(rig, indent=1), encoding="utf-8")
# Contact sheet of the three layers for checking the seams.
body, head, arm = (Image.open(out / n) for n in ("body.png", "head.png", "arm.png"))
sheet = Image.new("RGBA", (body.width + head.width + arm.width + 40, max(body.height, head.height, arm.height)), (230, 230, 230, 255))
x = 0
for layer in (body, head, arm):
    sheet.paste(layer, (x, 0), layer)
    x += layer.width + 20
sheet.convert("RGB").resize((sheet.width // 2, sheet.height // 2)).save(out / "_sheet.jpg", quality=80)
print("rig.json + _sheet.jpg written")
