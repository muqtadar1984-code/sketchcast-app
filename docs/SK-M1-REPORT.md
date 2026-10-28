# SK spike M1: Kit Manifest validation (2026-10-28)

Plan: `SketchCast SK Assistant - Final Plan 2026-10-28.md` §5.1, §5.2, §9.1, §9.6.
Code: `src/sk/manifest/derive.ts` (pure logic), `src/sk/manifest/prompts.ts` (versioned Haiku prompts),
`src/sk/manifest/__tests__/derive.test.ts` (9 tests), `tools/sk/manifest/derive.ts` (CLI).
Production was only read: SELECTs and Storage GETs. Nothing was written, no migration ran and no job was queued.
Kit data, frames and manifests stay in the session scratchpad and are not committed.

## 1. Verdict

| §9.6 validation | Acceptance | Measured | Pass? |
|---|---|---|---|
| Segment timing and completed-slide frames | 100 % | **87 / 87** end frames show the settled board (83 lesson segments + 4 outros) | yes |
| Concept ↔ segment | ≥ 95 % | **79 / 82 = 96.3 %** of mapped rows are right; 79 / 83 = 95.2 % if the 1 unavailable row counts against it | yes, but only just |
| Item ↔ concept | ≥ 98 %, the rest `unavailable` | **51 / 51 = 100 %** of mapped items are right. 13 / 64 are `unavailable`: 5 have no matching concept, and 8 could have been mapped but fell below the confidence bar | yes on precision; coverage is **80 %** |
| Uncertain → `unavailable` with reason | every row | 1 segment and 13 items, each with a reason | yes |
| Pinning and invalidation | pin ids, paths and a rows hash | `pinned.{script_ids, video_manifest_ids, format_version, artifact_paths, artifacts_hash}`. The unit tests show that a re-run row, a dropped row or a new format version makes `isStale()` true | yes, as logic only (no rebuild job) |

**Can S1 be estimated? Yes.** On five real kits, manifests can be built from what is already in production, with no worker change and for less than $0.003 per kit in Haiku calls. Coverage is the weak point, not accuracy. About 1 in 5 worksheet items, and 1 in 83 segments, comes back `unavailable`. SK has to plan around that (§9.1 fallbacks) rather than treat it as an edge case.

## 2. The five pilot kits

| generation | subject | parts | format_version | segments (+outro) | slides complete | concept ↔ segment | item ↔ concept (mapped / total) | concept source | items source |
|---|---|---|---|---|---|---|---|---|---|
| `eef426bd-523b-4fed-827c-95421263d89a` | Biology: Plant and Animal Cells (catalogue) | 1 | 3 | 18 (+1) | 19/19 | 18/18 | 19/19 (19/20) | article objectives o1–o6 | kit worksheet (10) + bank quiz (10) |
| `b8f6d34c-01f5-4746-b6ba-f8553b8c39eb` | Chemistry: States of Matter (catalogue) | 1 | 3 | 17 (+1) | 18/18 | 16/17 | 19/19 (19/20) | article objectives o1–o6 | kit worksheet (10) + bank quiz (10) |
| `2063bcc4-7d4c-4cad-8fc1-934880d1d3f3` | English: Headway Unit 1 (book) | **3** | **null (legacy)** | 27 | 27/27 | 26/26 (+1 unavailable) | 3/3 (3/10) | chapter_grounding (21) | worksheet (10) |
| `dfafb2f9-da9d-4e47-8ba7-c0388b8fcd89` | Mathematics: Mean (book) | 1 | **2 (legacy)** | 10 (+1) | 11/11 | 8/10 (1 wrong, 1 uncertain) | 5/5 (5/6) | chapter_grounding (8) | worksheet (6) |
| `9fa9704c-d068-4f6e-8616-18d9cbafc8f9` | Science: Air, water and weather (book) | 1 | 3 | 11 (+1) | 12/12 | 11/11 | 5/5 (5/8) | chapter_grounding (13) | worksheet (8) |

Extra degradation case, not counted: `f5530a03-f9d6-4c4f-b1d0-b42db9e4ef87` (Sci 7 Forces and energy, part 1 of 6, 2026-10-22). Its `chapter_grounding.concepts` is **NULL**. The manifest builds with `completeness.concepts = "none"`, every segment's concept is `unavailable`, and `remediate` is `unavailable`. Slides, segments, practice and explain all still work, which is what §9.1 asks for.

How the kits were chosen: presentation, `status='done'`, not withdrawn and not removed. The worksheet joins as the `worksheet` generation with the same `book_id`, the same `created_at` (book kits) or the same `params.kit_id` (catalogue). Catalogue items also come from the English "Online quiz" on the same article, which is bank-drawn: `params.question_set_id` → `question_sets.question_ids[i]` ↔ `q(i+1)`, confirmed by exact stem match on 20/20.

## 3. Segment timing and slide frames

- **T1.** `start_s`/`end_s` are the cumulative sum of `video.segments[].clip_duration_seconds`. The mp4 is a straight concatenation: its duration matched the summed clips to within 0.03 s on all 7 videos. `video.total_duration_seconds` is **not** reliable; it is 0.2–0.4 s short. The outro `s990` exists only in the video.
- **T2.** `slide_k` is the segment's 1-based position in `script.segments` for its part, so the deck has one slide per segment. The outro gets `slide_k = null`.
- **T3.** `slide_t = end_s − 0.0625 s`, about 1.5 frames at 24 fps, which is the last frame of the segment. **No `slide_t` offset is needed**: cuts are hard and no transition bleeds into the next segment.
- **How it was checked.** For all 87 segments, frames were taken at `end_s−0.0625` and at 0.5, 1, 2 and 3 s earlier (ffmpeg 7.1). Pixels that changed by more than 40/255 were counted outside the caption-bubble zone (x 715–1225, y 260–490 on 1280×720).
  - Every segment's board is static for **at least the last 0.5 s**. 73 of 87 are static for ≥ 2 s, and the shortest are the legacy Headway parts.
  - Inside the caption zone the speech bubble is usually **fading out** in the last 0.45 s, because `key_point_choreo` schedules the fade at cue + estimated speech time.
  - Laplacian variance of the end frames was 574–2864; the low end is the plain outro cards. Nothing was blurred mid-wipe.
- **By eye.** I looked at all five contact sheets and at full-size pairs for the suspicious ones. Every end frame shows the segment's finished drawing. The scratchpad sheets are `m1-out/contact_<generation_id>_o60.png`.
- **What the frame check does not catch: content fidelity.** A frame can be complete and still show the wrong picture. The board can keep showing an earlier picture under a new heading: Biology s010–s012 (headings: cell wall, chloroplasts, vacuole) still show the ER/Golgi drawing from s009, Headway p3 s005 "Active Listening" still shows the s004 grid, and Science s003 "Power of Wind" still shows the balloons. These segments pass "is the slide finished", but if SK says "here is the slide about cell walls" it would show ER/Golgi. That is a worker visual-plan defect, not a manifest one, and the manifest cannot detect it.
- **Cosmetic.** The narration caption bubble is burned into the video, so `slide(k)` frames often carry a half-faded caption.

## 4. Concept ↔ segment

- **Concept source.** Book kits use `chapter_grounding.concepts.concepts.concepts[]` (the field is nested three deep). Catalogue kits use `topic_articles.objectives[]` (`o1…`) of `params.article_id`.
- **`scene.concept` is empty on every segment of all five kits**, so the "scene.concept" rule in §5.2 never fires. Its only mechanical signal is the heading.
- **C1, heading rule.** A segment is mapped mechanically when all the content words of exactly one concept name appear in its heading, and that name has at least 2 content words. It matched 6 of 83 segments, all correct. Single-word names were excluded after the first run: "What is Air Made Of?" matched `Air` instead of `Composition of Air`.
- **C2, one Haiku 5.5 pass per kit** (`m1-concept-v1`) for the rest. The model returns `{primary | null, secondary[≤2], confidence, reason}`.
  - An assignment is accepted only if the ids exist and **confidence ≥ 0.7**. Otherwise the segment is `unavailable` with the reason.
  - `null` is a valid answer for hook, recap and preview segments.
- **Errors.**
  - 2 wrong. Both are `question_hook` segments that pose a problem on one concept (Chemistry s015, drying cloth = evaporation; Maths s008, "Try it" mean problem), and the model returned `null` for them.
  - 1 uncertain: Maths s004 got `Sum of Values` where `Arithmetic Mean` is arguably the primary concept.
  - 1 unavailable: Headway p2 s005 (conf 0.6).
  - Proposed fix for `m1-concept-v2`: tell the model that a `question_hook` maps to the concept it practises. Not run, so the reported numbers stay those of v1.

## 5. Item ↔ concept

- **I1, mechanical `objective_ref`.** This fired on only **3 of 20** catalogue bank items.
  - The other 17 bank items carry an `objective_ref` written against an **older article version**: `topic_questions.article_id` ≠ the kit's `article_id`.
  - The objective numbering changed between versions. For example, Cells `o1` meant prokaryote/eukaryote in article v2 and unit of life in v3.
  - Joining on `objective_ref` alone would have mis-tagged 9 of 17 (checked against the reviewed mapping; 8 agree). The rule therefore trusts `objective_ref` only when `bank.article_id == kit.article_id`. Otherwise the item goes to Haiku, with the old objective text passed as a hint.
- **Kit worksheets carry no tags at all.** None of the five questions files has `bank_item_id` or `objective_ref`.
  - The two catalogue kit worksheets were written by the model (`coverage` path), not drawn from the bank. Their stems match no bank stem; the best Jaccard was 0.81.
  - Worker #331 (merged 2026-10-27) keeps tags when items are bank-drawn. It does not help model-written worksheets.
- **I2, one Haiku 5.5 pass per kit** (`m1-item-v1`). It returns concepts[≤2], segments[≤3], confidence and a reason. An item is accepted only if its ids are valid and **confidence ≥ 0.8**; segment keys that do not exist are dropped.
- **Result.** All 51 mapped items are right. Of the 13 `unavailable`:
  - 5 have no matching concept: four Headway reading-comprehension facts about "Erika", and "range" in Mathematics, which is not a chapter concept.
  - 8 are lost coverage: four match-the-columns items that span several concepts, plus four items whose confidence was 0.6–0.75.
  - Raising coverage means a per-item second pass or a lower bar, and both trade against the 98 % precision target. Not tried.
- **Segment links.** Mathematics q2, q3 and q6 (median, mode) map correctly to concepts that **no segment of the video teaches**. Their `segment_ids` are empty, so a "show me where this was taught" move would correctly have nothing to show. Segment links were checked loosely: all plausible. For `objective_ref` items the links are every segment of that concept, which is broad.

## 6. Pinning, invalidation, completeness

- **Pinned.** `pinned` holds `script_ids` and `video_manifest_ids` per part, `format_version`, the sorted `artifact_paths`, and `artifacts_hash`. The hash is SHA-256 over `id|generation_id|kind|storage_path|created_at` of the presentation, worksheet and quiz rows.
- **Invalidation.** `isStale(manifest, currentRows, currentFormatVersion)` is the check a serve path must run. The unit tests show that a re-run (new `created_at`), a removed part and a format change all invalidate. The rebuild job (`kind: "manifest"`) is **not** built.
- **Completeness.** Kits with `format_version` null or below 3 get `script: "legacy"`. Both legacy kits (fv null, fv 2) still derive fully, because their script.json has the same shape.
- **Moves.** `moves` follows §9.1. `walkthrough` and `remediate` are `degraded` whenever any item is `unavailable`, which was the case on all five kits.

## 7. Cost

10 Haiku 5.5 calls (`global.anthropic.claude-haiku-5-5`, Bedrock, IAM user sketchcast-ops): **40,180 input + 9,220 output tokens = $0.0086**. That is about $0.0017 per kit at $0.10/M input and $0.50/M output (worker `MODEL_PRICING`). Replies are cached by input hash, so re-runs cost nothing.

Haiku 5.5 rejects `temperature`, with a 400 "deprecated for this model". The CLI therefore sends none and turns thinking off.

## 8. Worker changes

**Required for S1 to meet §9.6 without hand review:** none are blocking. These would remove the spike's weakest assumptions:

1. Keep the `objective_ref` **and the `article_id`/version** on every item in `*_questions.json`. #331 does this only for bank-drawn items, and kit worksheets are model-written. Either draw kit worksheets from the bank, or have the worksheet writer emit `objective_ref` against the article version the kit used.
2. Re-tag bank items to the current article version when an article is re-versioned. 17 of 20 quiz items pointed at superseded objective ids.

**Optional, but each one removes a model guess or a heuristic:**

3. Write `scene.concept` (or a `concept_ids[]` per segment) from the visual plan. The field exists but is empty on every M1 kit.
4. Write `section_id` and `segment_id` into the deck pptx notes, so that slide k ≡ segment k is checked rather than assumed. The deck was not inspected in M1, and catalogue decks are a separate `deck` generation.
5. Upload `words.json` (word timings) so that SK can seek inside a segment and line the caption up.
6. Emit `board_settled_s` per segment (end of the last board action) and keep the caption on a separate track, or export one clean PNG per slide. The `slide(k)` frame then carries no half-faded caption.
7. Flag segments whose board does not change while the heading does (the content-fidelity cases in §3), or fix the visual plan so each heading gets its own drawing.
8. Fix `video.total_duration_seconds` (it is 0.2–0.4 s short), or drop it.
9. Investigate `chapter_grounding.concepts IS NULL` on the 2026-10-22 Sci 7 kits. Concepts are missing, so remediation is unavailable for that whole book.

## 9. Not done in M1

- No `kind: "manifest"` job, no table and no serve path. Invalidation is logic plus tests only.
- Deck pptx files were not downloaded or compared slide by slide.
- No non-English kit was tested. Arabic and Jawi kits use the same script.json shape, but concept matching on headings is English-only (`contentTokens` is ASCII).
- The concept prompt fix (`m1-concept-v2`, question hooks) and a second item pass for coverage are proposed only.

## Appendix: hand review, every row

The reviewer is the spike author. "right" rows use the concept name as the reason. Every wrong, uncertain or unavailable row has its own reason. Item prompts are shown as `prompt_hash`; the text is in the scratchpad kit data.

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
