# SK spike M1: Kit Manifest validation (rev 2, 2026-10-28)

Plan: `SketchCast SK Assistant - Final Plan 2026-10-28.md` §5.1, §5.2, §9.1, §9.6.
Code:
- `src/sk/manifest/derive.ts` (pure logic)
- `src/sk/manifest/prompts.ts` (versioned prompts)
- `src/sk/manifest/__tests__/derive.test.ts` (16 tests)
- `tools/sk/manifest/derive.ts` (CLI)

Production was only read: SELECTs and Storage GETs. Nothing was written, no migration ran and no job was queued. Kit data, frames and manifests stay in the session scratchpad and are not committed.

Rev 2 adds the follow-ups the founder asked for:
- semantic visual suitability per segment;
- concept prompt v2 for question hooks;
- an Arabic kit and a Malay kit;
- a deck-alignment check;
- a translation-lineage rule for `objective_ref`.

## 1. Verdict

| §9.6 validation | Acceptance | Measured (7 kits: 5 en, 1 ar, 1 ms) | Pass? |
|---|---|---|---|
| Segment timing, slide frame is the finished board | 100 % | **117 / 117** end frames are settled (111 lesson segments + 6 outros); static for ≥ 0.5 s before `end_s` | yes |
| **Showing a frame is safe** (new, §3b) | wrong `frame` = 0 | **5 wrong `frame` verdicts out of 80 frames shown** (all Biology s013–s017: a mislabelled raster) → frame precision **75/80 = 93.8 %** | **no** |
| Concept ↔ segment | ≥ 95 % | **106 / 107 = 99.1 %** of mapped rows right (1 uncertain, 0 wrong); 4 rows unavailable → 106 / 111 = 95.5 % of all rows | yes |
| Item ↔ concept | ≥ 98 %; uncertain → unavailable | **79 / 80 = 98.75 %** of mapped items right (1 uncertain, 0 wrong). **Coverage 80 / 108 = 74 %**: 28 unavailable, 9 with no matching concept and 19 lost | yes on accuracy; coverage is low |
| Uncertain → `unavailable` with reason | every row | 4 segments, 28 items and 8 visual `unknown`, each with a reason | yes |
| Pinning and invalidation | pin ids, paths and a rows hash | unchanged from rev 1; the pin now also covers the deck rows; tested | yes (logic only) |

**Can S1 be estimated? Yes, with one hard condition.**
- **What works.** Concepts, items, timing and degradation can be built from production data at about **$0.004 per kit** in Haiku calls, and English, Arabic and Malay all work.
- **The condition.** `slide(k)` frames cannot yet be trusted to be safe to show. A model pass, even with a label-check rule and even with Sonnet 5.5, still shows a factually wrong drawing in 5 segments of one kit.
- **What S1 must budget for.** Treat "is this picture correct" as a worker/asset-gate responsibility (§8, item 1), not something SK can fix at runtime. Until that gate exists, SK can only show a slide as an illustration with the caption beside it, never "this is what a plant cell looks like".

## 2. The kits

| generation | subject | lang | parts | format_version | segments (+outro) | slides complete | concept right / mapped (unavail) | items right / mapped (total) | frames shown (wrong) | misleading flagged (right) | deck |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `eef426bd-523b-4fed-827c-95421263d89a` | Biology: Plant & Animal Cells (catalogue) | en | 1 | 3 | 18 (+1) | 19/19 | 18/18 (0) | 19/19 (20) | 14 (**5**) | 4 (4) | 23 slides ≠ 18 segs |
| `b8f6d34c-01f5-4746-b6ba-f8553b8c39eb` | Chemistry: States of Matter (catalogue) | en | 1 | 3 | 17 (+1) | 18/18 | 17/17 (0) | 19/19 (20) | 12 (0) | 5 (0) | 30 ≠ 17 |
| `2063bcc4-7d4c-4cad-8fc1-934880d1d3f3` | English: Headway (book) | en | **3** | **null** | 27 | 27/27 | 24/24 (3) | 3/3 (10) | 12 (0) | 11 (7 + 3 uncertain) | no deck (deck job errored) |
| `dfafb2f9-da9d-4e47-8ba7-c0388b8fcd89` | Maths: Mean (book) | en | 1 | **2** | 10 (+1) | 11/11 | 10/10 (0) | 5/5 (6) | 10 (0) | 0 | 17 ≠ 10 |
| `9fa9704c-d068-4f6e-8616-18d9cbafc8f9` | Science: Air, water, weather (book) | en | 1 | 3 | 11 (+1) | 12/12 | 11/11 (0) | 5/5 (8) | 9 (0) | 1 (1) | 19 ≠ 11 |
| `8f8f4a9a-4ce7-4718-af7b-45efc596e148` | Biology: Inheritance & Variation (catalogue) | **ar** | 1 | 3 | 17 (+1) | 18/18 | 16/17 (0), 1 uncertain | 15/16 (20), 1 uncertain | 12 (0) | 4 (3) | 19 ≠ 17 |
| `541fd796-4a47-4955-9288-276c6f942154` | Maths: Congruent Triangles (catalogue) | **ms** | 1 | 3 | 11 (+1) | 12/12 | 10/10 (1) | 13/13 (24) | 11 (0) | 0 | 19 ≠ 11 |

Extra degradation case, not counted: `f5530a03-f9d6-4c4f-b1d0-b42db9e4ef87` (Sci 7 Forces, part 1/6). Its `chapter_grounding.concepts` is NULL, so it gets concepts "none" and remediation unavailable. The other moves still work (§9.1).

## 3. Segment timing and slide frames (unchanged rules)

- **T1–T3, unchanged from rev 1.**
  - `start_s`/`end_s` are the cumulative sum of `clip_duration_seconds`; the mp4 is a plain concatenation, matching within 0.03 s on all 9 videos.
  - `slide_k` is the script order.
  - `slide_t = end_s − 0.0625 s`, the last frame. No offset is needed.
- **Arabic and Malay.** Every board is static for ≥ 2 s before `end_s`.
- **Caption bubble.** The narration caption is burned into the video and often half-faded in that last frame. This is cosmetic.

## 3b. Semantic visual suitability (new)

Each segment gets this per-segment `visual` object. It is the contract with the M2 Board controller and its field names are fixed:

```ts
visual: { status: "distinct"|"reused_relevant"|"misleading"|"unknown"; show: "frame"|"fallback_frame"|"caption_only";
          fallback_k?: number /* manifest k of the segment whose frame to show */; reason: string;
          judged_by: { model, prompt_version } }
```

The measurements behind it are in `visual_metrics` (`diff_prev`, `diff_min_earlier`, `nearest_earlier`, `model_confidence`).

### V1, mechanical distinctness

The frames are shrunk to 320×180 and the caption-bubble and avatar corners are masked out. The measure is the fraction of pixels that changed by more than 40/255, against segment k−1 and against every earlier segment of the kit. A frame is **distinct** when both values are **≥ 0.03**. The threshold was calibrated on the known reused boards:

| board | difference |
|---|---|
| Biology s010–s012 | 0.023 / 0 / 0 |
| Headway p3 s005 | 0.026 |
| Science s003 | 0 |
| new boards | ≥ 0.04, usually ≥ 0.09 |
| text slides (Maths) | 0.04–0.07 |

### V2, one multimodal Haiku 5.5 call per segment

Each call carries the 768×432 JPEG plus heading, points, narration and the mapped concept name. It returns a verdict of `matches`, `related` or `unrelated`. The prompt went through three versions:

| version | what it asked | outcome |
|---|---|---|
| `m1-visual-v1` | yes/no: does the drawing depict this segment | **rejected**: on Biology it flagged 10/18 frames, 7 of them a whole-cell diagram while one part was being discussed |
| `m1-visual-v2` | separates "related" (same object or topic, not misleading) from "unrelated" | better precision |
| `m1-visual-v3` (**used**) | v2 plus a label check: a label pointing at a drawing of something else counts as unrelated | used for all reported numbers |

### V3, the rule

| model verdict | distinct? | result |
|---|---|---|
| `matches`/`related` | yes | `distinct`, show `frame` |
| `matches`/`related` | no | `reused_relevant`, show `frame` |
| `unrelated` | — | `misleading`, then the fallback below |
| confidence < 0.7 or unparsable | — | `unknown`, show `caption_only` |

**Fallback for a misleading segment.** It borrows another segment's frame only when that frame:
- was itself judged `distinct` or `reused_relevant`;
- belongs to a segment with the same primary concept;
- differs from the misleading frame by ≥ 0.03, so it is not the same picture under another heading.

The nearest earlier segment is tried first, then the nearest later one. Otherwise the result is `caption_only`.

**Guards.** `assertNoMisleadingFrame()` throws if any `misleading` or `unknown` segment has `show: "frame"`, or if a fallback points at an unverified frame. Unit tests cover every verdict × difference combination.

**`moves.slide`** is `degraded` whenever any segment cannot show its own frame.

### Hand review, all 111 segments

| measure | result |
|---|---|
| frames shown (`frame` + `fallback_frame`) | 80 |
| **wrong frame (critical)** | **5**: Biology s013, s014, s015, s016, s017 |
| frame precision | 75/80 = **93.8 %** |
| flagged misleading | 25 |
| misleading right / uncertain / false positive | **15 / 3 / 7** → precision 15/25 = **60 %** (72 % counting uncertain) |
| `unknown` → caption_only | 8 (7 of them had a fine picture, i.e. lost coverage; 1 rightly withheld) |
| fallback frames used | 2: Arabic s015 → the s009 Punnett square; Chemistry s013 → the s011 state diagram. Both correct |

**Known cases.** All five are caught and shown as `caption_only`: Biology s010, s011, s012, Headway p3 s005 and Science s003.

**Root cause of the critical errors.** The `two_cells` library raster draws a **bacterium-like blob under the label "Plant cell"** (scene asset `two_cells`, layer `plant_cell_left`). Five later segments reuse that board.
- **Haiku v2/v3:** reads the labels and says "plant cell beside animal cell".
- **Sonnet 5.5 probe** (`--visual-model sonnet-5-5`, 6 frames, $0.035): flagged s013, s014 and s017 as mislabelled, but passed s015 and s016. It is not reliable either.
- **Conclusion.** This class (a wrong picture for a correct label) has to be stopped where the asset is made (worker image gate / registry approval), not in the manifest. Until then the manifest cannot promise "frame = true picture".

**False positives** are all the safe direction: the frame is withheld or replaced. Most are a reused diagram during a closely related subtopic (Chemistry s004, s008, s010, s012, s013).

## 4. Concept ↔ segment (`m1-concept-v2`)

**v2 change.** A `question_hook` that poses a task on one concept maps to that concept. It re-measured on all seven kits with the floor unchanged at 0.7. Against v1 on the five English kits:

| segment | v1 → v2 | effect |
|---|---|---|
| Chemistry s015 | null → o6 | fixed (was wrong) |
| Maths s008 | null → c1 | fixed (was wrong) |
| Maths s004 | c2 → c1 | fixed (was uncertain) |
| Headway p3 s004 | c003 → c004 | still right, better pick |
| Headway p2 s001, p2 s007 | null-available → unavailable | confidence 0.6 < 0.7; lost coverage, not error |

**Result on the five English kits:** 80/80 mapped rows right, 3 unavailable (80/83 = 96.4 %); in v1 it was 79/82.

**Language-aware matcher.** The heading rule's tokenizer, stop-words and stemmer are English only.
- It now runs only when the kit language is `en`/`en-*`, or when no language is stored and the heading is ASCII.
- Arabic, Malay and every other language skip it and go to the model pass.
- A test shows a Malay heading that *would* match token-for-token is not mechanically mapped.
- The heading rule mapped 6 of 83 English segments, all right.

| language | rows | right | uncertain | unavailable | §9.6 |
|---|---|---|---|---|---|
| en (5 kits) | 83 | 80 | 0 | 3 | 100 % of mapped |
| ar | 17 | 16 | 1 (s006, alleles → o1; o2/o3 fit as well) | 0 | 94.1 % strict / 100 % lenient: **borderline** |
| ms | 11 | 10 | 0 | 1 | 100 % of mapped |

## 5. Item ↔ concept (`m1-item-v1`, floor 0.8)

### Version-aware `objective_ref`

The rev 1 rule (I1) trusts `objective_ref` only when `bank.article_id == kit.article_id`.

**New in rev 2 (I1b):** a translated bank item (`source_item_id` set) is trusted only when its **source** item belongs to `topic_articles.source_article_id` of the kit's article, i.e. the English version the translation was made from. This was found on Arabic: the items carry the Arabic article id, but 4 of 10 copied `objective_ref` from source items written against the **older English v2 article** (89032457), whose o3/o4 mean different things. Without I1b, 3 of those 4 would have been mis-tagged (acquired variation → "sex inheritance"; independent assortment → "sex inheritance"; X/Y gametes → "Mendel"). With I1b they went to the model: 2 were mapped right and 2 became unavailable.

**Mechanical (objective_ref) items:** 19 of 108. Malay 10/10, Arabic 6/10, English catalogue 3/20.

### Results

| language | items | mapped | right | uncertain | unavailable (no concept / lost) |
|---|---|---|---|---|---|
| en (5 kits) | 64 | 51 | 51 | 0 | 13 (5 / 8) |
| ar | 20 | 16 | 15 | 1 (quiz q8: bank tag o2 for "23 chromosomes from the mother") | 4 (0 / 4) |
| ms | 24 | 13 | 13 | 0 | 11 (4 / 7) |
| **all** | **108** | **80** | **79 (98.75 %)** | 1 | **28 (9 / 19)** → coverage **74 %** |

**Coverage, honestly.**
- The lost items are mostly worksheet items that apply a concept to a calculation: Malay q1–q5 and q12–q13 sit at 0.6–0.75 confidence; there are also match-the-columns items.
- The floors (0.7 / 0.8) were **not** lowered.
- The one uncertain item is an `objective_ref` the bank itself assigned. Mechanical tags inherit the bank author's judgement.

## 6. Deck alignment (new)

The deck pptx was parsed with python-pptx in the worker venv, with the data directory treated as untrusted.

| kit | deck slides | script segments | title ≈ heading (sim ≥ 0.9) | notes ≈ narration (sim ≥ 0.9) |
|---|---|---|---|---|
| Biology en | 23 | 18 | 1/18 | 0/18 |
| Chemistry en | 30 | 17 | 0/17 | 0/17 |
| English (Headway) | — | 27 | deck generation `error`, no file | — |
| Maths en | 17 | 10 | 0/10 | 0/10 |
| Science en | 19 | 11 | 0/11 | 0/11 |
| Biology ar | 19 | 17 | 0/17 | 0/17 |
| Maths ms | 19 | 11 | 0/11 | 0/11 |

**There is no deck equivalence on any current kit.**
- **What the deck is.** It is a separate `deck` generation, the teacher deck built by Deck AI Director. Its slides are "ROADMAP", "LEARNING OBJECTIVES", "WATCH OUT FOR", "WORKED EXAMPLE" and so on, and its notes are teacher notes ("Welcome the class…") or image alt text, not narration.
- **Old 1:1 decks.** The `deck_pptx` stored inside a `presentation` generation existed only until 2026-08-31, and those kits have no `script.json` to compare against.
- **Consequence.** §5.1/§5.2's "slide k ≡ segment k" **does not hold**. `slide_k` in the manifest means "k-th script segment / video slide", not "k-th pptx slide". SK must take slides from the video frame (or a worker-exported per-segment PNG), never from the deck.

## 7. Cost

All on Bedrock, IAM user sketchcast-ops.

| pass | calls | input tokens | output tokens | $ |
|---|---|---|---|---|
| rev 1: concept v1 + items, 5 kits | 10 | 40,180 | 9,220 | 0.0086 |
| rev 2: concept v2 + items (ar/ms, Arabic re-run) | 10 | 50,554 | 9,562 | 0.0098 |
| rev 2: visual v1 (Bio), v2 (7 kits), v3 (7 kits + Bio retry) | 240 | 316,398 | 17,978 | 0.0406 |
| rev 2: Sonnet 5.5 visual probe (6 frames) | 6 | 8,507 | 1,797 | 0.0350 |
| **total** | **266** | | | **$0.094** (cap $5) |

**Steady-state cost per kit** (one of each pass, Haiku only) is about **$0.004–0.006**. The visual pass is about $0.00015 per segment.

API quirks:
- Haiku 5.5 rejects `temperature`.
- Sonnet 5.5 rejects `thinking: disabled` and needs `between_tools`.

## 8. Worker changes

**Required before SK may say "here is the slide about X":**

1. **Asset correctness gate.** A library raster must match its labels and layers. `two_cells.plant_cell_left` is a bacterium. Verification has to happen at publish time: registry approval, the image gate, or a human check. Neither Haiku nor Sonnet catches it reliably at manifest time.
2. **Keep `objective_ref` together with the article id and version** on every item, including model-written worksheets. Re-tag bank items when an article is re-versioned. Translated items must take their source's article version into account.

**Strongly recommended:**

3. **Give each heading its own drawing**, or flag segments whose board does not change while the heading does. Biology s010–s012 and Headway p3 s005 are visual-plan failures.
4. **Emit per-segment clean slide PNGs**, or `board_settled_s` plus the caption on its own track. This avoids burned-in captions, and the visual check would no longer need the mask heuristics.

**Optional:**

5. Write `scene.concept` (empty everywhere).
6. Upload `words.json`.
7. Fix `video.total_duration_seconds`.
8. Investigate the NULL `chapter_grounding.concepts` on the 2026-10-22 Sci 7 kits.
9. If a 1:1 handout deck is ever wanted, write `segment_id` into the slide notes. The current teacher deck is a different artifact.

## 9. Not done

- No manifest job, table or serve path; invalidation is logic plus tests.
- Visual v3 was tuned on the same 7 kits it is scored on, so the numbers are in-sample.
- No second item pass to raise coverage.
- The Sonnet probe covered 6 frames only.
- Arabic was reviewed by the spike author with working Arabic. It is not a native-speaker review.
- The 8 unparsed or low-confidence visual replies were not retried.

## Appendix A: rev 2 hand review, every row (7 kits)

The reviewer is the spike author. Visual verdict codes:
- **CRIT**: a frame shown while the picture misleads.
- **FP**: flagged misleading although the frame was fine (safe).
- **unknown (lost)**: withheld although the picture was fine.

Concept "right" rows use the concept name as the reason.

### Biology (catalogue, en) — `eef426bd-523b-4fed-827c-95421263d89a`

Concepts: `o1` State that the cell is the basic structural and functional unit of lif; `o2` Distinguish prokaryotic cells from eukaryotic cells and classify plant; `o3` Describe the structure and function of the cell membrane, cytoplasm, n; `o4` Describe the structure and function of the cell wall, chloroplasts and; `o5` Describe the similarities and differences between the structures of pl; `o6` Identify an unlabelled cell as plant or animal from its structures, gi

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | Life's tiny building block | null (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | The cell: unit of life | o1 (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s003 | One cell or many | o1 (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s004 | Prokaryotic and eukaryotic cells | o2 (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s005 | Cell membrane: the gate | o3 (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s006 | Cytoplasm and the nucleus | o3 (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s007 | Chromosomes and DNA | o3 (model, 0.85) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s008 | Mitochondria: the powerhouses | o3 (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s009 | ER and Golgi: factory line | o3 (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s010 | Cell wall: rigid support | o4 (model, 0.9) | right | misleading / caption_only | right | picture is about another subject |
| p1:s011 | Chloroplasts make food | o4 (model, 0.9) | right | misleading / caption_only | right | picture is about another subject |
| p1:s012 | Vacuole and turgor pressure | o4 (model, 0.9) | right | misleading / caption_only | right | picture is about another subject |
| p1:s013 | Shared parts and differences | o5 (model, 0.9) | right | distinct / frame | CRIT | 'Plant cell' label points at a bacterium-like blob (wrong raster in asset two_cells); learner sees a wrong plant cell |
| p1:s014 | The lifestyle pattern | o5 (model, 0.85) | right | reused_relevant / frame | CRIT | same mislabelled two-cell drawing |
| p1:s015 | Detective: plant or animal | o6 (model, 0.9) | right | reused_relevant / frame | CRIT | same mislabelled two-cell drawing |
| p1:s016 | Your turn: name the cell | o6 (model, 0.9) | right | reused_relevant / frame | CRIT | same mislabelled two-cell drawing |
| p1:s017 | Putting it together | null (+o1,o2) (model, 0.8) | right | reused_relevant / frame | CRIT | same mislabelled two-cell drawing |
| p1:s018 | Test yourself outdoors | null (+o6) (model, 0.8) | right | misleading / caption_only | right | preview over the mislabelled drawing: caption_only is the safe call |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | o1 → p1:s002 (model, 0.95) | right | assesses State that the cell is the basic structural and fu |
| ws:q2 | o2 → p1:s004 (model, 0.95) | right | assesses Distinguish prokaryotic cells from eukaryotic cell |
| ws:q3 | o3 → p1:s005 (model, 0.93) | right | assesses Describe the structure and function of the cell me |
| ws:q4 | o3 → p1:s008 (model, 0.93) | right | assesses Describe the structure and function of the cell me |
| ws:q5 | o1 → p1:s003 (model, 0.9) | right | assesses State that the cell is the basic structural and fu |
| ws:q6 | o2 → p1:s013 (model, 0.92) | right | assesses Distinguish prokaryotic cells from eukaryotic cell |
| ws:q7 | o4 → p1:s010 (model, 0.85) | right | assesses Describe the structure and function of the cell wa |
| ws:q8 | o3 → p1:s009 (model, 0.88) | right | assesses Describe the structure and function of the cell me |
| ws:q9 | — → p1:s008,p1:s009 (model, 0.7) | unavailable | lost: match item spans o3 organelles; multi-concept |
| ws:q10 | o2 → p1:s004 (model, 0.92) | right | assesses Distinguish prokaryotic cells from eukaryotic cell |
| quiz:q1 | o2 → p1:s004 (model, 0.95) | right | assesses Distinguish prokaryotic cells from eukaryotic cell |
| quiz:q2 | o2 → p1:s013 (model, 0.92) | right | assesses Distinguish prokaryotic cells from eukaryotic cell |
| quiz:q3 | o3 → p1:s005 (model, 0.93) | right | assesses Describe the structure and function of the cell me |
| quiz:q4 | o3 → p1:s008 (model, 0.95) | right | assesses Describe the structure and function of the cell me |
| quiz:q5 | o2 → p1:s004 (model, 0.95) | right | assesses Distinguish prokaryotic cells from eukaryotic cell |
| quiz:q6 | o3 → p1:s009 (model, 0.85) | right | assesses Describe the structure and function of the cell me |
| quiz:q7 | o5 → p1:s010,p1:s013 (model, 0.9) | right | o5 (differences) fits; o4 (cell wall) would also be defensible |
| quiz:q8 | o5 → p1:s010,p1:s012 (model, 0.8) | right | assertion-reason on why plant cells keep shape = o5 'explain why each difference exists' |
| quiz:q9 | o4 → p1:s012 (model, 0.9) | right | assesses Describe the structure and function of the cell wa |
| quiz:q10 | o5 → p1:s013,p1:s014 (objective_ref, 1) | right | assesses Describe the similarities and differences between  |

### Chemistry (catalogue, en) — `b8f6d34c-01f5-4746-b6ba-f8553b8c39eb`

Concepts: `o1` Define matter and state the main ideas of the particle model.; `o2` Describe solids, liquids and gases in terms of the arrangement, separa; `o3` Explain diffusion in gases and liquids as the net movement of particle; `o4` Explain why diffusion matters for cells taking in and releasing substa; `o5` Describe melting, freezing, evaporation, condensation and sublimation,; `o6` Explain why evaporation causes cooling.

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | The mystery of the ink drop | null (+o1,o3) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | What is matter? | o1 (+o2) (model, 0.9) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p1:s003 | Particles and the spaces between | o1 (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s004 | Motion versus attraction | o1 (+o2) (model, 0.85) | right | misleading / caption_only | FP | ink-in-water particle glass fits 'motion versus attraction' (same particle model) |
| p1:s005 | Solids and liquids | o2 (model, 0.92) | right | distinct / frame | right | picture fits the segment |
| p1:s006 | Gases, compression and density | o2 (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s007 | Diffusion down a gradient | o3 (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s008 | Speed of diffusion | o3 (+o2) (model, 0.85) | right | misleading / caption_only | FP | diffusion drawing fits 'speed of diffusion' |
| p1:s009 | Diffusion across cell membranes | o4 (+o3) (model, 0.93) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s010 | Why cells are small | o4 (+o3) (model, 0.9) | right | misleading / caption_only | FP | diffusion-into-cell drawing fits 'why cells are small' (diffusion distance) |
| p1:s011 | Melting and freezing | o5 (+o2) (model, 0.93) | right | distinct / frame | right | picture fits the segment |
| p1:s012 | Evaporation and cooling | o6 (+o5) (model, 0.93) | right | misleading / caption_only | FP | state-change diagram with Evaporation label fits |
| p1:s013 | Condensation and sublimation | o5 (model, 0.9) | right | misleading / fallback_frame → k10 | FP | state-change diagram fits; fallback to s011's version of it is harmless |
| p1:s014 | Evaporation versus boiling | o5 (+o6) (model, 0.88) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s015 | Test your thinking | o6 (+o5) (model, 0.8) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s016 | One model explains it all | null (+o1,o2) (model, 0.85) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s017 | Test yourself in daily life | null (+o5,o6) (model, 0.8) | right | reused_relevant / frame | right | picture fits the segment |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | o1 → p1:s002 (model, 0.9) | right | assesses Define matter and state the main ideas of the part |
| ws:q2 | o1 → p1:s004 (model, 0.85) | right | assesses Define matter and state the main ideas of the part |
| ws:q3 | o2 → p1:s005 (model, 0.9) | right | assesses Describe solids, liquids and gases in terms of the |
| ws:q4 | o3 → p1:s007 (model, 0.95) | right | assesses Explain diffusion in gases and liquids as the net  |
| ws:q5 | o1 → p1:s002 (model, 0.8) | right | assesses Define matter and state the main ideas of the part |
| ws:q6 | o2 → p1:s005 (model, 0.85) | right | assesses Describe solids, liquids and gases in terms of the |
| ws:q7 | o2 → p1:s006 (model, 0.9) | right | assesses Describe solids, liquids and gases in terms of the |
| ws:q8 | o3 → p1:s007 (model, 0.85) | right | assesses Explain diffusion in gases and liquids as the net  |
| ws:q9 | — → p1:s005,p1:s006 (model, 0.7) | unavailable | lost: match item = o2 (states); model conf 0.7 |
| ws:q10 | o1 → p1:s003 (model, 0.8) | right | assesses Define matter and state the main ideas of the part |
| quiz:q1 | o1 → p1:s004 (model, 0.9) | right | assesses Define matter and state the main ideas of the part |
| quiz:q2 | o2 → p1:s005 (model, 0.9) | right | assesses Describe solids, liquids and gases in terms of the |
| quiz:q3 | o5 → p1:s011 (model, 0.95) | right | assesses Describe melting, freezing, evaporation, condensat |
| quiz:q4 | o5 → p1:s013 (model, 0.95) | right | assesses Describe melting, freezing, evaporation, condensat |
| quiz:q5 | o2 → p1:s005 (model, 0.85) | right | assesses Describe solids, liquids and gases in terms of the |
| quiz:q6 | o1 → p1:s004 (model, 0.9) | right | assesses Define matter and state the main ideas of the part |
| quiz:q7 | o5 → p1:s011,p1:s013,p1:s014 (objective_ref, 1) | right | assesses Describe melting, freezing, evaporation, condensat |
| quiz:q8 | o3 → p1:s008 (model, 0.85) | right | assesses Explain diffusion in gases and liquids as the net  |
| quiz:q9 | o6 → p1:s012 (model, 0.95) | right | assesses Explain why evaporation causes cooling. |
| quiz:q10 | o1 → p1:s002,p1:s003,p1:s004 (objective_ref, 1) | right | assesses Define matter and state the main ideas of the part |

### English (book, en, 3 parts) — `2063bcc4-7d4c-4cad-8fc1-934880d1d3f3`

Concepts: `p1-c001` Information Questions with Wh- Questions; `p1-c002` Describing People (Appearance and Personality); `p1-c003` Describing Places (Properties and Location); `p1-c004` Describing Things (Specifications and Features); `p1-c005` Adjective-Noun Collocations; `p1-c006` Compound Adjectives; `p1-c007` -ed vs -ing Adjectives (Participial Adjectives); `p2-c001` Personality Adjectives; `p2-c002` Adjective Opposites and Prefixes; `p2-c003` Character Analysis; `p2-c004` Literary Theme of Escapism; `p2-c005` Documentary Film Narrative; `p3-c001` Adjectives of Personality and Character; `p3-c002` Idioms for Relationships; `p3-c003` Syntactic Inversion for Emphasis; `p3-c004` Cleft Sentences and Emphatic Structures; `p3-c005` Conversational Backchanneling; `p3-c006` Intonation and Vocal Range in Social Interaction; `p3-c007` Distinguishing Fact vs. Personal Opinion; `p3-c008` Adjective Modifiers (Grading Adjectives); `p3-c009` Descriptive Portrait Writing

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | What's your story? | null (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | Unlocking Information | p1-c001 (model, 0.9) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p1:s003 | People: Looks vs. Character | p1-c002 (+p1-c001) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s004 | The Adjective Train | p1-c006 (+p2-c001) (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s005 | Describing Places | p1-c003 (model, 0.8) | right | distinct / frame | right | picture fits the segment |
| p1:s006 | Specs of a Device | p1-c004 (+p1-c001) (model, 0.85) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p1:s007 | The Emotion Engine | p1-c007 (model, 0.95) | right | misleading / caption_only | right | picture is about another subject |
| p1:s008 | Your Story Toolkit | null (+p1-c001,p1-c002) (model, 0.75) | right | misleading / caption_only | uncertain | recap over the -ed/-ing laptop board |
| p1:s009 | Coming Up Next... | null (model, 0.9) | right | misleading / caption_only | right | picture is about another subject |
| p2:s001 | What's your story? Part 2 | null (model, 0.6) | unavailable | misleading / caption_only | right | lost: hook on describing the Angulo brothers (p2-c003); conf 0.6 (v1 had null/available) · picture is about another subject |
| p2:s002 | Who you are inside | p2-c001 (model, 0.8) | right | misleading / caption_only | uncertain | seesaw 'Inner Personality Mirror' under 'Who you are inside' |
| p2:s003 | Opposites and Prefixes | p2-c002 (+p2-c001) (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p2:s004 | The Power of Escapism | p2-c004 (+p2-c005) (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p2:s005 | Then and Now | null (model, 0.65) | unavailable | distinct / frame | right | lost: 'write three adjectives' hook practises p2-c001; conf 0.6 · picture fits the segment |
| p2:s006 | Documenting Reality | p2-c005 (+p2-c004) (model, 0.9) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p2:s007 | Next time: Writing Biographies | null (model, 0.6) | unavailable | misleading / caption_only | right | preview of biography writing: no part-2 concept fits; unavailable is acceptable · picture is about another subject |
| p3:s001 | Describing the Inner Person | null (+p3-c001) (model, 0.7) | right | distinct / frame | right | picture fits the segment |
| p3:s002 | The Birth Order Cast | p3-c001 (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p3:s003 | Idioms for Relationships | p3-c002 (heading, 0.95) | right | distinct / frame | right | picture fits the segment |
| p3:s004 | Creating Emphasis | p3-c004 (+p3-c003) (model, 0.9) | right | misleading / caption_only | FP | SVO / cleft-sentence grid IS the emphasis lesson |
| p3:s005 | Active Listening | p3-c005 (model, 0.95) | right | misleading / caption_only | right | picture is about another subject |
| p3:s006 | The Voice Rollercoaster | p3-c006 (+p3-c005) (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p3:s007 | Fact vs. Personal Opinion | p3-c007 (+p3-c009) (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p3:s008 | Adjective Modifiers | p3-c008 (model, 0.95) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p3:s009 | Your Turn to Write | p3-c009 (+p3-c001,p3-c004) (model, 0.7) | right | misleading / caption_only | right | picture is about another subject |
| p3:s010 | The Storyteller's Toolkit | null (+p3-c001,p3-c004) (model, 0.85) | right | misleading / caption_only | uncertain | recap over the gradable-adjective thermometer |
| p3:s011 | Observe the World | null (model, 0.85) | right | misleading / caption_only | right | picture is about another subject |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | p1-c004 → p1:s006 (model, 0.85) | right | assesses Describing Things (Specifications and Features) |
| ws:q2 | p1-c004 → p1:s006 (model, 0.8) | right | assesses Describing Things (Specifications and Features) |
| ws:q3 | — → p1:s005 (model, 0.75) | unavailable | lost: kitchen-diner = describing places (p1-c003) |
| ws:q4 | — → p1:s003 (model, 0.6) | unavailable | lost: greenish-brown = describing people / compound adjective |
| ws:q5 | — → — (model, 0.2) | unavailable | correct: reading-comprehension fact about Erika; no concept |
| ws:q6 | — → — (model, 0.2) | unavailable | correct: reading-comprehension fact; no concept |
| ws:q7 | p1-c004 → p1:s006 (model, 0.8) | right | assesses Describing Things (Specifications and Features) |
| ws:q8 | — → p1:s003 (model, 0.7) | unavailable | lost: match = wh-questions about people (p1-c002) |
| ws:q9 | — → — (model, 0.25) | unavailable | correct: reading-comprehension fact; no concept |
| ws:q10 | — → — (model, 0.3) | unavailable | correct: reading-comprehension fact; no concept |

### Mathematics (book, en) — `dfafb2f9-da9d-4e47-8ba7-c0388b8fcd89`

Concepts: `c1` Arithmetic Mean; `c2` Sum of Values; `c3` Deviation from Mean; `c4` Assumed Mean Method; `c5` Sum of Deviations; `c6` Median; `c7` Median of Even and Odd Datasets; `c8` Mode

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | Mean 8 Class 7.1: Content | null (+c1) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | Mean 8 Class 7.1: Content | c1 (+c2,c3) (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s003 | Example 1: Find the arithmetic mean of t | c1 (heading, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s004 | Example 2: The mean of six numbers is 15 | c1 (+c2) (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s005 | Example 3: The mean weight of 10 student | c1 (+c2) (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s006 | Example 4: The mean of four observations | c1 (+c2) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s007 | Common mistakes | c1 (+c2) (model, 0.8) | right | distinct / frame | right | picture fits the segment |
| p1:s008 | Try it | c1 (+c2) (model, 0.85) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s009 | Try it: The mean of five scores is 14. I | c1 (+c2) (model, 0.9) | right | distinct / frame | right | picture fits the segment |
| p1:s010 | Mean 8 Class 7.1: Content | null (model, 0.95) | right | reused_relevant / frame | right | picture fits the segment |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | c1 → p1:s002,p1:s003 (model, 0.95) | right | assesses Arithmetic Mean |
| ws:q2 | c6 → — (model, 0.9) | right | assesses Median |
| ws:q3 | c8 → — (model, 0.95) | right | assesses Mode |
| ws:q4 | — → — (model, 0.1) | unavailable | correct: 'range' is not in the chapter's concept list |
| ws:q5 | c1 → p1:s002,p1:s003 (model, 0.9) | right | assesses Arithmetic Mean |
| ws:q6 | c7 → — (model, 0.8) | right | assesses Median of Even and Odd Datasets |

### Science (book, en) — `9fa9704c-d068-4f6e-8616-18d9cbafc8f9`

Concepts: `c001` Air; `c002` Wind; `c003` Composition of Air; `c004` Air Pollution; `c005` States of Water; `c006` Evaporation; `c007` Condensation; `c008` The Water Cycle; `c009` Groundwater; `c010` Weather; `c011` Storms and Cyclones; `c012` Seasons; `c013` Climate

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | Invisible Air Around Us | null (+c001) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | Air Takes Shape and Rises | c001 (model, 0.8) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s003 | The Power of Wind | c002 (+c001) (model, 0.95) | right | misleading / caption_only | right | picture is about another subject |
| p1:s004 | What is Air Made Of? | c003 (+c001) (model, 0.95) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p1:s005 | Breathing and Air Pollution | c004 (heading, 0.95) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s006 | The Blue Planet and States of Water | c005 (heading, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s007 | The Water Cycle | c008 (heading, 0.95) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s008 | Fresh Water and Weather vs Climate | c009 (+c010,c013) (model, 0.8) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s009 | Storms, Cyclones, and Seasons | c011 (heading, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s010 | How It All Connects | c012 (+c002,c008) (model, 0.75) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s011 | Observe the World Around You | null (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | c002 → p1:s003 (model, 0.95) | right | assesses Wind |
| ws:q2 | c003 → p1:s005 (model, 0.85) | right | no 'breathing' concept exists; c003 Composition of Air is the nearest listed concept |
| ws:q3 | — → p1:s008 (model, 0.6) | unavailable | lost: rain as purest water = fresh water / water cycle |
| ws:q4 | — → p1:s002 (model, 0.7) | unavailable | lost: hot air rises = c001 Air (s002) |
| ws:q5 | c005 → p1:s006 (model, 0.8) | right | assesses States of Water |
| ws:q6 | c012 → p1:s010 (model, 0.95) | right | assesses Seasons |
| ws:q7 | — → p1:s003,p1:s007 (model, 0.7) | unavailable | lost: match spans wind (c002) + condensation (c007) |
| ws:q8 | c005 → p1:s006 (model, 0.95) | right | assesses States of Water |

### Biology: Inheritance (catalogue, ar) — `8f8f4a9a-4ce7-4718-af7b-45efc596e148`

Concepts: `o1` اذكر أن الكروموسومات توجد في النواة وتحتوي على الجينات، وأن الجينات تت; `o2` اشرح كيف تسهم الجينات في تحديد صفات الكائن الحي.; `o3` صِف تزاوج مندل أحادي الصفة واذكر قانونَي الانعزال والتوزيع المستقل.; `o4` اشرح وراثة الجنس عند الإنسان من خلال الكروموسومات XX وXY.; `o5` صِف التباين داخل النوع الواحد واربطه بالاختلافات الجينية بين الأفراد.

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | أين تعيش تعليماتكم | null (+o1) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | ما الوراثة؟ | null (+o2) (model, 0.8) | right | unknown / caption_only | unknown (lost) | picture was fine; withheld for low confidence / unparsed reply |
| p1:s003 | النواة، الكروموسوم، الجين | o1 (model, 0.95) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s004 | الحمض النووي (DNA): السلّم المشفّر | o1 (+o2) (model, 0.85) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s005 | الجينات والبروتينات والصفات | o2 (+o1) (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s006 | الأليلات وأزواج الكروموسومات | o1 (+o3) (model, 0.75) | uncertain | distinct / frame | right | alleles & chromosome pairs → o1; o2/o3 fit at least as well · picture fits the segment |
| p1:s007 | تجربة مندل على البازلاء | o3 (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s008 | سائد، متنحٍّ، النمط الجيني | o3 (model, 0.85) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s009 | التنبؤ باستخدام مربع بانيت | o3 (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s010 | قانونا مندل | o3 (model, 0.95) | right | misleading / caption_only | FP | monohybrid pea cross is the law-of-segregation picture |
| p1:s011 | كيف يتحدد الجنس | o4 (+o1) (model, 0.95) | right | distinct / frame | right | picture fits the segment |
| p1:s012 | التباين داخل النوع الواحد | o5 (+o2) (model, 0.95) | right | misleading / caption_only | right | picture is about another subject |
| p1:s013 | مصادر التباين الجيني | o5 (+o3) (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s014 | الطفرة والتوائم والإخوة | o5 (model, 0.85) | right | unknown / caption_only | right | withheld; picture would mislead |
| p1:s015 | لغز لتجربوه | o3 (model, 0.85) | right | misleading / fallback_frame → k8 | right | picture is about another subject |
| p1:s016 | جمع كل شيء معًا | null (+o1,o2) (model, 0.8) | right | reused_relevant / frame | right | picture fits the segment |
| p1:s017 | اختبروا أنفسكم | null (+o3,o5) (model, 0.75) | right | misleading / caption_only | right | picture is about another subject |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | o1 → p1:s003,p1:s004 (model, 0.85) | right | assesses اذكر أن الكروموسومات توجد في النواة وتحتوي على الج |
| ws:q2 | o3 → p1:s006 (model, 0.8) | right | assesses صِف تزاوج مندل أحادي الصفة واذكر قانونَي الانعزال  |
| ws:q3 | o3 → p1:s007,p1:s009 (model, 0.9) | right | assesses صِف تزاوج مندل أحادي الصفة واذكر قانونَي الانعزال  |
| ws:q4 | — → p1:s011 (model, 0.7) | unavailable | lost: 23 chromosomes in a gamete = o1/o4 |
| ws:q5 | o2 → p1:s005 (model, 0.9) | right | assesses اشرح كيف تسهم الجينات في تحديد صفات الكائن الحي. |
| ws:q6 | o4 → p1:s011 (model, 0.9) | right | assesses اشرح وراثة الجنس عند الإنسان من خلال الكروموسومات  |
| ws:q7 | o3 → p1:s008 (model, 0.85) | right | assesses صِف تزاوج مندل أحادي الصفة واذكر قانونَي الانعزال  |
| ws:q8 | — → p1:s008 (model, 0.6) | unavailable | lost: match genotype/phenotype/allele = o3 |
| ws:q9 | o1 → p1:s003,p1:s004 (model, 0.85) | right | assesses اذكر أن الكروموسومات توجد في النواة وتحتوي على الج |
| ws:q10 | o3 → p1:s010 (model, 0.95) | right | assesses صِف تزاوج مندل أحادي الصفة واذكر قانونَي الانعزال  |
| quiz:q1 | — → p1:s013,p1:s014 (model, 0.7) | unavailable | lost: acquired variation not inherited = o5 (bank tag o4 from an older source version, rejected by I1b) |
| quiz:q2 | — → p1:s006 (model, 0.6) | unavailable | lost: 46 chromosomes = o1 (bank tag rejected by I1b) |
| quiz:q3 | o1 → p1:s003,p1:s004,p1:s006 (objective_ref, 1) | right | assesses اذكر أن الكروموسومات توجد في النواة وتحتوي على الج |
| quiz:q4 | o3 → p1:s007,p1:s008,p1:s009,p1:s010,p1:s015 (objective_ref, 1) | right | assesses صِف تزاوج مندل أحادي الصفة واذكر قانونَي الانعزال  |
| quiz:q5 | o5 → p1:s013,p1:s014 (model, 0.8) | right | assesses صِف التباين داخل النوع الواحد واربطه بالاختلافات ا |
| quiz:q6 | o1 → p1:s003,p1:s004,p1:s006 (objective_ref, 1) | right | assesses اذكر أن الكروموسومات توجد في النواة وتحتوي على الج |
| quiz:q7 | o2 → p1:s005 (objective_ref, 1) | right | assesses اشرح كيف تسهم الجينات في تحديد صفات الكائن الحي. |
| quiz:q8 | o2 → p1:s005 (objective_ref, 1) | uncertain | bank tag o2 (same lineage) for '23 chromosomes from the mother'; o1/o4 fit better |
| quiz:q9 | o5 → p1:s012,p1:s013,p1:s014 (objective_ref, 1) | right | assesses صِف التباين داخل النوع الواحد واربطه بالاختلافات ا |
| quiz:q10 | o4 → p1:s011 (model, 0.8) | right | assesses اشرح وراثة الجنس عند الإنسان من خلال الكروموسومات  |

### Maths: Congruent triangles (catalogue, ms) — `541fd796-4a47-4955-9288-276c6f942154`

Concepts: `o1` Takrifkan maksud dua segi tiga itu kongruen.; `o2` Kenal pasti dan gunakan empat syarat kekongruenan piawai: SSS, SAS, AS; `o3` Tulis bukti geometri yang formal untuk menunjukkan kekongruenan segi t

| segment | heading | concept (method, conf) | concept verdict | visual status / show | visual verdict | reason |
|---|---|---|---|---|---|---|
| p1:s001 | Segi Tiga Kongruen: SSS, SAS, ASA dan RH | null (+o2) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s002 | Segi Tiga Kongruen: SSS, SAS, ASA dan RH | o1 (+o2) (model, 0.85) | right | distinct / frame | right | picture fits the segment |
| p1:s003 | Contoh 1: Antara segi tiga ini, yang man | o2 (+o1) (model, 0.8) | right | distinct / frame | right | picture fits the segment |
| p1:s004 | Contoh 2: Segi tiga A, B dan C masing-ma | o2 (+o1) (model, 0.8) | right | distinct / frame | right | picture fits the segment |
| p1:s005 | Contoh 3: Segi tiga ABC mempunyai sudut  | o2 (+o1) (model, 0.75) | right | distinct / frame | right | picture fits the segment |
| p1:s006 | Contoh 4: Segi tiga ABC ialah segi tiga  | null (model, 0.6) | unavailable | distinct / frame | right | lost: isosceles base-angle proof = o3/o2; conf 0.6 · picture fits the segment |
| p1:s007 | Contoh 5: Segi tiga ABC mempunyai sudut  | o2 (+o1) (model, 0.75) | right | distinct / frame | right | picture fits the segment |
| p1:s008 | Kesilapan lazim | o3 (+o2) (model, 0.8) | right | distinct / frame | right | picture fits the segment |
| p1:s009 | Cuba sendiri | o2 (+o1) (model, 0.7) | right | distinct / frame | right | picture fits the segment |
| p1:s010 | Cuba sendiri: Setiap segi tiga bersudut  | o2 (+o1) (model, 0.8) | right | distinct / frame | right | picture fits the segment |
| p1:s011 | Segi Tiga Kongruen: SSS, SAS, ASA dan RH | null (model, 0.9) | right | reused_relevant / frame | right | picture fits the segment |

| item | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|
| ws:q1 | — → p1:s001,p1:s002 (model, 0.6) | unavailable | lost: corresponding sides of congruent triangles = o1 |
| ws:q2 | — → p1:s001,p1:s002 (model, 0.6) | unavailable | lost: corresponding angles of congruent triangles = o1 |
| ws:q3 | — → p1:s001 (model, 0.75) | unavailable | lost: SSS correspondence = o2 |
| ws:q4 | — → p1:s001 (model, 0.75) | unavailable | lost: SAS correspondence = o2 |
| ws:q5 | — → p1:s001,p1:s005 (model, 0.75) | unavailable | lost: ASA correspondence = o2 |
| ws:q6 | o2 → p1:s003 (model, 0.8) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| ws:q7 | o2 → p1:s003 (model, 0.8) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| ws:q8 | o2 → p1:s003 (model, 0.8) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| ws:q9 | — → p1:s009,p1:s010 (model, 0.5) | unavailable | correct: 'which triangle is right-angled' tests no listed congruence objective |
| ws:q10 | — → p1:s009,p1:s010 (model, 0.5) | unavailable | correct: right-angle identification only |
| ws:q11 | — → p1:s009,p1:s010 (model, 0.5) | unavailable | correct: right-angle identification only |
| ws:q12 | — → p1:s007 (model, 0.7) | unavailable | lost: AAS-from-ASA angle sum = o2 |
| ws:q13 | — → p1:s006 (model, 0.7) | unavailable | lost: isosceles base angle via SAS twin = o2/o3 |
| ws:q14 | — → p1:s007 (model, 0.65) | unavailable | correct: plain angle-sum exercise; no congruence objective |
| quiz:q1 | o1 → p1:s002 (objective_ref, 1) | right | assesses Takrifkan maksud dua segi tiga itu kongruen. |
| quiz:q2 | o2 → p1:s003,p1:s004,p1:s005,p1:s007,p1:s009,p1:s010 (objective_ref, 1) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| quiz:q3 | o1 → p1:s002 (objective_ref, 1) | right | assesses Takrifkan maksud dua segi tiga itu kongruen. |
| quiz:q4 | o2 → p1:s003,p1:s004,p1:s005,p1:s007,p1:s009,p1:s010 (objective_ref, 1) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| quiz:q5 | o1 → p1:s002 (objective_ref, 1) | right | assesses Takrifkan maksud dua segi tiga itu kongruen. |
| quiz:q6 | o2 → p1:s003,p1:s004,p1:s005,p1:s007,p1:s009,p1:s010 (objective_ref, 1) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| quiz:q7 | o2 → p1:s003,p1:s004,p1:s005,p1:s007,p1:s009,p1:s010 (objective_ref, 1) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| quiz:q8 | o3 → p1:s008 (objective_ref, 1) | right | assesses Tulis bukti geometri yang formal untuk menunjukkan |
| quiz:q9 | o2 → p1:s003,p1:s004,p1:s005,p1:s007,p1:s009,p1:s010 (objective_ref, 1) | right | assesses Kenal pasti dan gunakan empat syarat kekongruenan  |
| quiz:q10 | o1 → p1:s002 (objective_ref, 1) | right | assesses Takrifkan maksud dua segi tiga itu kongruen. |

## Appendix B: rev 1 hand review (concept v1, 5 English kits), kept for comparison

### Biology (catalogue) — `eef426bd-523b-4fed-827c-95421263d89a`

Concepts: `o1` State that the cell is the basic structural and functional unit of life and dist; `o2` Distinguish prokaryotic cells from eukaryotic cells and classify plant and anima; `o3` Describe the structure and function of the cell membrane, cytoplasm, nucleus, ch; `o4` Describe the structure and function of the cell wall, chloroplasts and large cen; `o5` Describe the similarities and differences between the structures of plant and an; `o6` Identify an unlabelled cell as plant or animal from its structures, giving reaso

| segment | heading | assigned (method, conf) | verdict | reason |
|---|---|---|---|---|
| p1:s001 | Life's tiny building block | null (model, 0.9) | right | hook segment, no single concept |
| p1:s002 | The cell: unit of life | o1 (model, 0.9) | right | teaches State that the cell is the basic structural and functional u |
| p1:s003 | One cell or many | o1 (model, 0.9) | right | teaches State that the cell is the basic structural and functional u |
| p1:s004 | Prokaryotic and eukaryotic cells | o2 (+o1) (model, 0.9) | right | teaches Distinguish prokaryotic cells from eukaryotic cells and clas |
| p1:s005 | Cell membrane: the gate | o3 (model, 0.9) | right | teaches Describe the structure and function of the cell membrane, cy |
| p1:s006 | Cytoplasm and the nucleus | o3 (model, 0.85) | right | teaches Describe the structure and function of the cell membrane, cy |
| p1:s007 | Chromosomes and DNA | o3 (model, 0.85) | right | teaches Describe the structure and function of the cell membrane, cy |
| p1:s008 | Mitochondria: the powerhouses | o3 (model, 0.9) | right | teaches Describe the structure and function of the cell membrane, cy |
| p1:s009 | ER and Golgi: factory line | o3 (model, 0.85) | right | teaches Describe the structure and function of the cell membrane, cy |
| p1:s010 | Cell wall: rigid support | o4 (model, 0.9) | right | teaches Describe the structure and function of the cell wall, chloro |
| p1:s011 | Chloroplasts make food | o4 (model, 0.9) | right | teaches Describe the structure and function of the cell wall, chloro |
| p1:s012 | Vacuole and turgor pressure | o4 (model, 0.9) | right | teaches Describe the structure and function of the cell wall, chloro |
| p1:s013 | Shared parts and differences | o5 (+o3,o4) (model, 0.9) | right | teaches Describe the similarities and differences between the struct |
| p1:s014 | The lifestyle pattern | o5 (model, 0.85) | right | teaches Describe the similarities and differences between the struct |
| p1:s015 | Detective: plant or animal | o6 (+o4) (model, 0.9) | right | teaches Identify an unlabelled cell as plant or animal from its stru |
| p1:s016 | Your turn: name the cell | o6 (model, 0.9) | right | teaches Identify an unlabelled cell as plant or animal from its stru |
| p1:s017 | Putting it together | null (+o1,o2) (model, 0.75) | right | synthesis segment, no single concept |
| p1:s018 | Test yourself outdoors | null (+o6) (model, 0.8) | right | preview segment, no single concept |

| item | prompt | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|---|
| ws:q1 | b19e43ffdfa63660 | o1 → p1:s002 (model, 0.95) | right | assesses State that the cell is the basic structural and functional u |
| ws:q2 | 2b6bf0682a5fcf8c | o2 → p1:s004 (model, 0.95) | right | assesses Distinguish prokaryotic cells from eukaryotic cells and clas |
| ws:q3 | 4c764d3e24fbcdb6 | o3 → p1:s005 (model, 0.93) | right | assesses Describe the structure and function of the cell membrane, cy |
| ws:q4 | bab4c2fd0c233908 | o3 → p1:s008 (model, 0.93) | right | assesses Describe the structure and function of the cell membrane, cy |
| ws:q5 | a2e093f131aa8e6f | o1 → p1:s003 (model, 0.9) | right | assesses State that the cell is the basic structural and functional u |
| ws:q6 | cd94aa824659750b | o2 → p1:s013 (model, 0.92) | right | assesses Distinguish prokaryotic cells from eukaryotic cells and clas |
| ws:q7 | 7c7c6dbeaa330a07 | o4 → p1:s010 (model, 0.85) | right | assesses Describe the structure and function of the cell wall, chloro |
| ws:q8 | 11b64268b78c6338 | o3 → p1:s009 (model, 0.88) | right | assesses Describe the structure and function of the cell membrane, cy |
| ws:q9 | 83e4869da5a9fa03 | — → p1:s008,p1:s009 (model, 0.7) | unavailable | lost: match item spans o3 organelles; multi-concept |
| ws:q10 | eb4b2bdcec265457 | o2 → p1:s004 (model, 0.92) | right | assesses Distinguish prokaryotic cells from eukaryotic cells and clas |
| quiz:q1 | e98a8798bb797ab1 | o2 → p1:s004 (model, 0.95) | right | assesses Distinguish prokaryotic cells from eukaryotic cells and clas |
| quiz:q2 | 4e2dd0c0ea5ba4ec | o2 → p1:s013 (model, 0.92) | right | assesses Distinguish prokaryotic cells from eukaryotic cells and clas |
| quiz:q3 | 17523aefa9e9d50f | o3 → p1:s005 (model, 0.93) | right | assesses Describe the structure and function of the cell membrane, cy |
| quiz:q4 | e396aba72561f654 | o3 → p1:s008 (model, 0.95) | right | assesses Describe the structure and function of the cell membrane, cy |
| quiz:q5 | 93d4ff38a9b92122 | o2 → p1:s004 (model, 0.95) | right | assesses Distinguish prokaryotic cells from eukaryotic cells and clas |
| quiz:q6 | 3ce71931ee140c85 | o3 → p1:s009 (model, 0.85) | right | assesses Describe the structure and function of the cell membrane, cy |
| quiz:q7 | 7c0304078a3ad539 | o5 → p1:s010,p1:s013 (model, 0.9) | right | o5 (differences) fits; o4 (cell wall) would also be defensible |
| quiz:q8 | 50eb7127ac030074 | o5 → p1:s010,p1:s012 (model, 0.8) | right | assertion-reason on why plant cells keep shape = o5 'explain why each difference exists' |
| quiz:q9 | 150aa9f25a46079d | o4 → p1:s012 (model, 0.9) | right | assesses Describe the structure and function of the cell wall, chloro |
| quiz:q10 | 7c6c0452ef1003f0 | o5 → p1:s013,p1:s014 (objective_ref, 1) | right | assesses Describe the similarities and differences between the struct |

### Chemistry (catalogue) — `b8f6d34c-01f5-4746-b6ba-f8553b8c39eb`

Concepts: `o1` Define matter and state the main ideas of the particle model.; `o2` Describe solids, liquids and gases in terms of the arrangement, separation and m; `o3` Explain diffusion in gases and liquids as the net movement of particles from hig; `o4` Explain why diffusion matters for cells taking in and releasing substances.; `o5` Describe melting, freezing, evaporation, condensation and sublimation, including; `o6` Explain why evaporation causes cooling.

| segment | heading | assigned (method, conf) | verdict | reason |
|---|---|---|---|---|
| p1:s001 | The mystery of the ink drop | null (model, 0.9) | right | hook segment, no single concept |
| p1:s002 | What is matter? | o1 (model, 0.85) | right | teaches Define matter and state the main ideas of the particle model |
| p1:s003 | Particles and the spaces between | o1 (model, 0.85) | right | teaches Define matter and state the main ideas of the particle model |
| p1:s004 | Motion versus attraction | o1 (+o2) (model, 0.8) | right | teaches Define matter and state the main ideas of the particle model |
| p1:s005 | Solids and liquids | o2 (model, 0.9) | right | teaches Describe solids, liquids and gases in terms of the arrangeme |
| p1:s006 | Gases, compression and density | o2 (model, 0.9) | right | teaches Describe solids, liquids and gases in terms of the arrangeme |
| p1:s007 | Diffusion down a gradient | o3 (model, 0.95) | right | teaches Explain diffusion in gases and liquids as the net movement o |
| p1:s008 | Speed of diffusion | o3 (+o2) (model, 0.8) | right | teaches Explain diffusion in gases and liquids as the net movement o |
| p1:s009 | Diffusion across cell membranes | o4 (+o3) (model, 0.9) | right | teaches Explain why diffusion matters for cells taking in and releas |
| p1:s010 | Why cells are small | o4 (+o3) (model, 0.8) | right | teaches Explain why diffusion matters for cells taking in and releas |
| p1:s011 | Melting and freezing | o5 (model, 0.9) | right | teaches Describe melting, freezing, evaporation, condensation and su |
| p1:s012 | Evaporation and cooling | o6 (+o5) (model, 0.9) | right | teaches Explain why evaporation causes cooling. |
| p1:s013 | Condensation and sublimation | o5 (model, 0.9) | right | teaches Describe melting, freezing, evaporation, condensation and su |
| p1:s014 | Evaporation versus boiling | o5 (+o6) (model, 0.8) | right | teaches Describe melting, freezing, evaporation, condensation and su |
| p1:s015 | Test your thinking | null (+o6) (model, 0.8) | wrong | question hook asks which cloth dries faster = evaporation (o5/o6); model gave null |
| p1:s016 | One model explains it all | null (+o1,o2) (model, 0.85) | right | synthesis segment, no single concept |
| p1:s017 | Test yourself in daily life | null (+o5) (model, 0.85) | right | preview segment, no single concept |

| item | prompt | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|---|
| ws:q1 | 6d8c82ca89598236 | o1 → p1:s002 (model, 0.9) | right | assesses Define matter and state the main ideas of the particle model |
| ws:q2 | 37fe85530e65d2d5 | o1 → p1:s004 (model, 0.85) | right | assesses Define matter and state the main ideas of the particle model |
| ws:q3 | 7776a629df673e7d | o2 → p1:s005 (model, 0.9) | right | assesses Describe solids, liquids and gases in terms of the arrangeme |
| ws:q4 | e54987315c27938f | o3 → p1:s007 (model, 0.95) | right | assesses Explain diffusion in gases and liquids as the net movement o |
| ws:q5 | 590af5bb31158283 | o1 → p1:s002 (model, 0.8) | right | assesses Define matter and state the main ideas of the particle model |
| ws:q6 | ac5b1aa21fb6d4aa | o2 → p1:s005 (model, 0.85) | right | assesses Describe solids, liquids and gases in terms of the arrangeme |
| ws:q7 | f1536fee408e4c94 | o2 → p1:s006 (model, 0.9) | right | assesses Describe solids, liquids and gases in terms of the arrangeme |
| ws:q8 | 84bd381db3a992e1 | o3 → p1:s007 (model, 0.85) | right | assesses Explain diffusion in gases and liquids as the net movement o |
| ws:q9 | 83e4869da5a9fa03 | — → p1:s005,p1:s006 (model, 0.7) | unavailable | lost: match item = o2 (states); model conf 0.7 |
| ws:q10 | 4275807b335f0dc5 | o1 → p1:s003 (model, 0.8) | right | assesses Define matter and state the main ideas of the particle model |
| quiz:q1 | f2744c0ed70e365c | o1 → p1:s004 (model, 0.9) | right | assesses Define matter and state the main ideas of the particle model |
| quiz:q2 | 84b343110a93a8f8 | o2 → p1:s005 (model, 0.9) | right | assesses Describe solids, liquids and gases in terms of the arrangeme |
| quiz:q3 | 7114dd3e76588cd8 | o5 → p1:s011 (model, 0.95) | right | assesses Describe melting, freezing, evaporation, condensation and su |
| quiz:q4 | cc6ac49ceeb9c84a | o5 → p1:s013 (model, 0.95) | right | assesses Describe melting, freezing, evaporation, condensation and su |
| quiz:q5 | 2e0f1d75422e0ec1 | o2 → p1:s005 (model, 0.85) | right | assesses Describe solids, liquids and gases in terms of the arrangeme |
| quiz:q6 | 3674ee12bb3dd204 | o1 → p1:s004 (model, 0.9) | right | assesses Define matter and state the main ideas of the particle model |
| quiz:q7 | da171304ce20f57f | o5 → p1:s011,p1:s013,p1:s014 (objective_ref, 1) | right | assesses Describe melting, freezing, evaporation, condensation and su |
| quiz:q8 | 7bcb58b0dfd93e34 | o3 → p1:s008 (model, 0.85) | right | assesses Explain diffusion in gases and liquids as the net movement o |
| quiz:q9 | 271fff4c4e4abf5e | o6 → p1:s012 (model, 0.95) | right | assesses Explain why evaporation causes cooling. |
| quiz:q10 | 17c49c384b9389b0 | o1 → p1:s002,p1:s003,p1:s004 (objective_ref, 1) | right | assesses Define matter and state the main ideas of the particle model |

### English (book) — `2063bcc4-7d4c-4cad-8fc1-934880d1d3f3`

Concepts: `p1-c001` Information Questions with Wh- Questions; `p1-c002` Describing People (Appearance and Personality); `p1-c003` Describing Places (Properties and Location); `p1-c004` Describing Things (Specifications and Features); `p1-c005` Adjective-Noun Collocations; `p1-c006` Compound Adjectives; `p1-c007` -ed vs -ing Adjectives (Participial Adjectives); `p2-c001` Personality Adjectives; `p2-c002` Adjective Opposites and Prefixes; `p2-c003` Character Analysis; `p2-c004` Literary Theme of Escapism; `p2-c005` Documentary Film Narrative; `p3-c001` Adjectives of Personality and Character; `p3-c002` Idioms for Relationships; `p3-c003` Syntactic Inversion for Emphasis; `p3-c004` Cleft Sentences and Emphatic Structures; `p3-c005` Conversational Backchanneling; `p3-c006` Intonation and Vocal Range in Social Interaction; `p3-c007` Distinguishing Fact vs. Personal Opinion; `p3-c008` Adjective Modifiers (Grading Adjectives); `p3-c009` Descriptive Portrait Writing

| segment | heading | assigned (method, conf) | verdict | reason |
|---|---|---|---|---|
| p1:s001 | What's your story? | null (model, 0.9) | right | hook segment, no single concept |
| p1:s002 | Unlocking Information | p1-c001 (model, 0.9) | right | teaches Information Questions with Wh- Questions |
| p1:s003 | People: Looks vs. Character | p1-c002 (+p1-c001) (model, 0.85) | right | teaches Describing People (Appearance and Personality) |
| p1:s004 | The Adjective Train | p1-c006 (+p1-c002) (model, 0.9) | right | teaches Compound Adjectives |
| p1:s005 | Describing Places | p1-c003 (model, 0.8) | right | teaches Describing Places (Properties and Location) |
| p1:s006 | Specs of a Device | p1-c004 (+p1-c001) (model, 0.85) | right | teaches Describing Things (Specifications and Features) |
| p1:s007 | The Emotion Engine | p1-c007 (model, 0.95) | right | teaches -ed vs -ing Adjectives (Participial Adjectives) |
| p1:s008 | Your Story Toolkit | null (+p1-c001,p1-c002) (model, 0.7) | right | synthesis segment, no single concept |
| p1:s009 | Coming Up Next... | null (model, 0.9) | right | preview segment, no single concept |
| p2:s001 | What's your story? Part 2 | null (+p2-c003) (model, 0.75) | right | hook segment, no single concept |
| p2:s002 | Who you are inside | p2-c001 (model, 0.8) | right | teaches Personality Adjectives |
| p2:s003 | Opposites and Prefixes | p2-c002 (+p2-c001) (model, 0.9) | right | teaches Adjective Opposites and Prefixes |
| p2:s004 | The Power of Escapism | p2-c004 (+p2-c003) (model, 0.95) | right | teaches Literary Theme of Escapism |
| p2:s005 | Then and Now | null (model, 0.6) | unavailable | lost: 'write three adjectives' hook practises p2-c001/p2-c003; model conf 0.6 |
| p2:s006 | Documenting Reality | p2-c005 (+p2-c004) (model, 0.9) | right | teaches Documentary Film Narrative |
| p2:s007 | Next time: Writing Biographies | null (model, 0.8) | right | preview segment, no single concept |
| p3:s001 | Describing the Inner Person | null (+p3-c001) (model, 0.7) | right | hook segment, no single concept |
| p3:s002 | The Birth Order Cast | p3-c001 (+p3-c002) (model, 0.8) | right | teaches Adjectives of Personality and Character |
| p3:s003 | Idioms for Relationships | p3-c002 (heading, 0.95) | right | teaches Idioms for Relationships |
| p3:s004 | Creating Emphasis | p3-c003 (+p3-c004) (model, 0.85) | right | narration names both inversion (c003) and cleft sentences (c004, secondary) |
| p3:s005 | Active Listening | p3-c005 (model, 0.95) | right | teaches Conversational Backchanneling |
| p3:s006 | The Voice Rollercoaster | p3-c006 (+p3-c005) (model, 0.9) | right | teaches Intonation and Vocal Range in Social Interaction |
| p3:s007 | Fact vs. Personal Opinion | p3-c007 (+p3-c009) (model, 0.95) | right | teaches Distinguishing Fact vs. Personal Opinion |
| p3:s008 | Adjective Modifiers | p3-c008 (model, 0.95) | right | teaches Adjective Modifiers (Grading Adjectives) |
| p3:s009 | Your Turn to Write | p3-c009 (+p3-c003,p3-c004) (model, 0.7) | right | teaches Descriptive Portrait Writing |
| p3:s010 | The Storyteller's Toolkit | null (+p3-c001,p3-c002) (model, 0.8) | right | synthesis segment, no single concept |
| p3:s011 | Observe the World | null (model, 0.85) | right | preview segment, no single concept |

| item | prompt | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|---|
| ws:q1 | fd1a35487891666c | p1-c004 → p1:s006 (model, 0.85) | right | assesses Describing Things (Specifications and Features) |
| ws:q2 | 0e157cb78071bfe9 | p1-c004 → p1:s006 (model, 0.8) | right | assesses Describing Things (Specifications and Features) |
| ws:q3 | ed14b161bad0be03 | — → p1:s005 (model, 0.75) | unavailable | lost: kitchen-diner = describing places (p1-c003) |
| ws:q4 | b88a34b4ae125d3b | — → p1:s003 (model, 0.6) | unavailable | lost: greenish-brown = describing people / compound adjective |
| ws:q5 | 3acbd24253028399 | — → — (model, 0.2) | unavailable | correct: reading-comprehension fact about Erika; no concept |
| ws:q6 | 52a3e00afdd295a6 | — → — (model, 0.2) | unavailable | correct: reading-comprehension fact; no concept |
| ws:q7 | d6b65b63b7582479 | p1-c004 → p1:s006 (model, 0.8) | right | assesses Describing Things (Specifications and Features) |
| ws:q8 | 83e4869da5a9fa03 | — → p1:s003 (model, 0.7) | unavailable | lost: match = wh-questions about people (p1-c002) |
| ws:q9 | 03e7854bdd7d5d03 | — → — (model, 0.25) | unavailable | correct: reading-comprehension fact; no concept |
| ws:q10 | 283edf1a93612b31 | — → — (model, 0.3) | unavailable | correct: reading-comprehension fact; no concept |

### Mathematics (book) — `dfafb2f9-da9d-4e47-8ba7-c0388b8fcd89`

Concepts: `c1` Arithmetic Mean; `c2` Sum of Values; `c3` Deviation from Mean; `c4` Assumed Mean Method; `c5` Sum of Deviations; `c6` Median; `c7` Median of Even and Odd Datasets; `c8` Mode

| segment | heading | assigned (method, conf) | verdict | reason |
|---|---|---|---|---|
| p1:s001 | Mean 8 Class 7.1: Content | null (model, 0.9) | right | hook segment, no single concept |
| p1:s002 | Mean 8 Class 7.1: Content | c1 (+c2,c3) (model, 0.9) | right | teaches Arithmetic Mean |
| p1:s003 | Example 1: Find the arithmetic mean of the dataset | c1 (heading, 0.95) | right | teaches Arithmetic Mean |
| p1:s004 | Example 2: The mean of six numbers is 15. If five  | c2 (+c1) (model, 0.8) | uncertain | missing-value example: c2 Sum of Values defensible, c1 Arithmetic Mean arguably primary |
| p1:s005 | Example 3: The mean weight of 10 students is 45 kg | c1 (+c2) (model, 0.75) | right | teaches Arithmetic Mean |
| p1:s006 | Example 4: The mean of four observations is 20. Wh | c1 (+c2) (model, 0.75) | right | teaches Arithmetic Mean |
| p1:s007 | Common mistakes | c1 (+c2) (model, 0.8) | right | teaches Arithmetic Mean |
| p1:s008 | Try it | null (model, 0.85) | wrong | 'Try it' poses a mean problem = c1; model gave null |
| p1:s009 | Try it: The mean of five scores is 14. If four of  | c1 (+c2) (model, 0.8) | right | teaches Arithmetic Mean |
| p1:s010 | Mean 8 Class 7.1: Content | null (model, 0.95) | right | preview segment, no single concept |

| item | prompt | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|---|
| ws:q1 | 58e603474edd3f9f | c1 → p1:s002,p1:s003 (model, 0.95) | right | assesses Arithmetic Mean |
| ws:q2 | fd2338f07f5354b5 | c6 → — (model, 0.9) | right | assesses Median |
| ws:q3 | cba7e5ce6b328de1 | c8 → — (model, 0.95) | right | assesses Mode |
| ws:q4 | 12403e39e8292db1 | — → — (model, 0.1) | unavailable | correct: 'range' is not in the chapter's concept list |
| ws:q5 | c59e1c489f23b4dc | c1 → p1:s002,p1:s003 (model, 0.9) | right | assesses Arithmetic Mean |
| ws:q6 | 6abaebd7799785b4 | c7 → — (model, 0.8) | right | assesses Median of Even and Odd Datasets |

### Science (book) — `9fa9704c-d068-4f6e-8616-18d9cbafc8f9`

Concepts: `c001` Air; `c002` Wind; `c003` Composition of Air; `c004` Air Pollution; `c005` States of Water; `c006` Evaporation; `c007` Condensation; `c008` The Water Cycle; `c009` Groundwater; `c010` Weather; `c011` Storms and Cyclones; `c012` Seasons; `c013` Climate

| segment | heading | assigned (method, conf) | verdict | reason |
|---|---|---|---|---|
| p1:s001 | Invisible Air Around Us | null (+c001) (model, 0.7) | right | hook segment, no single concept |
| p1:s002 | Air Takes Shape and Rises | c001 (model, 0.8) | right | teaches Air |
| p1:s003 | The Power of Wind | c002 (model, 0.95) | right | teaches Wind |
| p1:s004 | What is Air Made Of? | c003 (+c001) (model, 0.95) | right | teaches Composition of Air |
| p1:s005 | Breathing and Air Pollution | c004 (heading, 0.95) | right | teaches Air Pollution |
| p1:s006 | The Blue Planet and States of Water | c005 (heading, 0.95) | right | teaches States of Water |
| p1:s007 | The Water Cycle | c008 (heading, 0.95) | right | teaches The Water Cycle |
| p1:s008 | Fresh Water and Weather vs Climate | c009 (+c010,c013) (model, 0.7) | right | covers groundwater AND weather vs climate; c010/c013 carried as secondary |
| p1:s009 | Storms, Cyclones, and Seasons | c011 (heading, 0.95) | right | teaches Storms and Cyclones |
| p1:s010 | How It All Connects | c012 (+c002,c008) (model, 0.7) | right | teaches Seasons |
| p1:s011 | Observe the World Around You | null (model, 0.9) | right | preview segment, no single concept |

| item | prompt | concepts → segments (method, conf) | verdict | reason |
|---|---|---|---|---|
| ws:q1 | 6b4408792bc2fccc | c002 → p1:s003 (model, 0.95) | right | assesses Wind |
| ws:q2 | 149cbc810bb54efb | c003 → p1:s005 (model, 0.85) | right | no 'breathing' concept exists; c003 Composition of Air is the nearest listed concept |
| ws:q3 | e455f1c07bdc9760 | — → p1:s008 (model, 0.6) | unavailable | lost: rain as purest water = fresh water / water cycle |
| ws:q4 | ce3db7894a22572c | — → p1:s002 (model, 0.7) | unavailable | lost: hot air rises = c001 Air (s002) |
| ws:q5 | e88f0fe81f50db53 | c005 → p1:s006 (model, 0.8) | right | assesses States of Water |
| ws:q6 | b2af20b98b3af1ce | c012 → p1:s010 (model, 0.95) | right | assesses Seasons |
| ws:q7 | 83e4869da5a9fa03 | — → p1:s003,p1:s007 (model, 0.7) | unavailable | lost: match spans wind (c002) + condensation (c007) |
| ws:q8 | bb72d2b5cd5f04eb | c005 → p1:s006 (model, 0.95) | right | assesses States of Water |
