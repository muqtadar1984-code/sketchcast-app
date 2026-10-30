# SK model-first routing

Founder, 2026-10-30: *"why do we need to train SK. cant we use one of the LLMs like haiku 5.5 or sonnet 5.5 and combine it with the underlying knowledge as the RAG and let them handle the conversations?"* → approved **"Yes, switch"**.

This puts the SK Shell (`POST /api/sk/shell/turn`) on **model-first** routing behind a switch. The old rules path stays, and it is still the default.

## The switches

| Env | Values | Effect |
| --- | --- | --- |
| `SK_ROUTING` | unset (default) | **Rules**, except for users listed in `SK_MODEL_FIRST_EMAILS`. |
| | `model` | Model-first for everyone. |
| | `rules` | Rules for everyone; the allow-list is ignored. **This is the one-switch rollback.** |
| `SK_MODEL_FIRST_EMAILS` | comma-separated emails | Model-first for these users only when `SK_ROUTING` is unset. Matching ignores case. Put the founder here to try it alone. |
| `SK_FAST_MODEL` | default `claude-haiku-5-5` | The model for short or command-like messages. |
| `SK_SHELL_MODEL` | default `claude-sonnet-5-5` | The model for teaching, RAG and anything complex. Also the full model in rules routing, as before. |
| `SK_TRANSLATE_MODEL` | default `claude-haiku-5-5` | "Say that in X" (unchanged). |
| `SK_BEDROCK_REGION` | e.g. `ap-southeast-2` | **SK only.** The Bedrock region for SK's calls. Unset means today's behaviour (`BEDROCK_REGION`, default `us-east-1`). |
| `SK_BEDROCK_MODEL_MAP` | JSON object | **SK only.** Model-id overlay, e.g. `{"claude-sonnet-5-5":"au.anthropic.claude-sonnet-5-5","claude-haiku-5-5":"au.anthropic.claude-haiku-5-5"}`. It wins over `BEDROCK_MODEL_MAP` and the built-in table, for SK's calls only. A malformed value is ignored and logged. |

`SK_BEDROCK_*` is read only by SK's server calls:

- the Shell turn route: the fast and full models, the teaching, selection and board-knowledge calls, and the translation;
- `src/sk/server.ts`: the router, teacher and translate providers.

Every other Claude call in the app keeps `BEDROCK_REGION` and `BEDROCK_MODEL_MAP`. On the first-party API (`CLAUDE_BACKEND=anthropic`) both are ignored: ids pass through, and there is no region. The code is in `src/sk/claude-target.ts`. The changes in `src/utils/claude-backend.ts` are `claudeClient({ region })` and `claudeModel(id, overlay)`.

Intended production values, set later: `SK_BEDROCK_REGION=ap-southeast-2` and the `au.*` map above. Both profiles are ACTIVE in ap-southeast-2 and route to ap-southeast-2 and ap-southeast-4.

## What model-first does

**Every message goes to the model first**, with the role's full tool set (`allowedFor(ctx)`, in registry order, so the list is stable per role).

Rules keep three jobs only. They run before the model:

1. **Yes/no to a pending offer.** This is the greeting's one-turn offer ("Your kit … is ready — want me to open it?", `offer.ts`).
   - Confirm cards are click-only or confirmed by a spoken yes on the client (`client/confirm.ts`). The token goes to `/api/sk/act`. That path is unchanged and never reaches the turn route.
2. **Instant tour controls while a tour is narrating.** When the client reports `walk.active`, next/back/pause/skip/resume are matched by `walkCommand`. No model is called.
3. **A book code, or the answer SK asked for.** A text that contains a code (`SKB…`/`SKE…`), or the short answer to SK's own book question (`memory.pending`), runs `book.activate` directly. **A code never becomes part of a model prompt.**
   - An activation phrase with no code ("I have a code") goes to the model, whose `book.activate` tool asks for the code.

**Permission and safety stay in the registry and the role gates, not in phrase rules:**

- `allowedFor` (roles ∩ hat ∩ flags ∩ plans) decides which tools the model is given. `runCapability` checks the same predicate again at execution time.
- A student is never given a teacher action. The coverage test asserts this.
- Confirm-tier tools only issue a card; nothing is executed in the turn route.
- The leader school-read gate (analytics flag, 60/day cap, audit row) runs inside `runCapability`.
- The action-claim guard still drops "I've emailed / posted / deleted …" when no card backs it.

### Which model (`chooseModel`, `src/sk/shell/routing.ts`)

The choice is deterministic and uses cheap signals:

- **Sonnet 5.5** in three cases:
  - a lesson, a kit or a highlight is open (`ctx.board.sessionId`, `ctx.board.selection`, `ctx.tutor.kit`);
  - the message is a teaching or explanation ask: explain / why / how does / compare / define …, or a content question ("what is osmosis?") that is not about her own data;
  - the message is long (over 160 characters or 24 words) and is not a command.
- **Haiku 5.5** otherwise, when the message is command-like (an imperative verb first, after the greeting is stripped) or short (12 words or fewer).

**Escalation.** Haiku's first round is held until it ends. It is replayed on Sonnet before any tool runs when either:

- it wants a knowledge or teaching tool: `knowledge.search`, `board.explain`, `board.compare`, `board.explain_selection` or `tutor.explain`;
- it answers with low confidence: empty, "I'm not sure", "I don't know", or "I have nothing on that".

After an escalation, later rounds stay on Sonnet, and the tokens of the Haiku round are added to the turn's usage. Two cases never escalate:

- a student's `knowledge.search` and `tutor.explain`, which are hand-offs (below);
- an error.

### Hand-offs: tools the route performs itself

- **A student's `knowledge.search`.** Her own metered, student-ruled kit turn runs (`knowledgeForStudent`, one live turn), exactly as the rules path does. The Shell model never narrates the passages for a student. If nothing answers, the open lesson's `tutor.explain` runs; with no lesson open, `tutor.where` runs.
- **`start_lesson` with no book, chapter or kit (a teacher).** The rules' planner runs: the Board's own pick, then the timetable (`start-lesson.ts`).
- **`start_tour`, `tour_control`, `set_answer_language`, `repeat_in_language`.** These are performed as their rule performs them (as before).
- **A tutor move or tutor.\*'s own reply (a student).** It is emitted as the `tutor` event or the reply, with no narrating round.

All other tool results produce the same client events the rules did: `navigate`, `confirm` (the token is issued in the route), `board`, `walkthrough`, `lang`, and `citations`.

### Every rules ability is a tool

`src/sk/shell/intent-tools.ts` is the inventory: pages, Board moves, teacher and leader actions, tutor moves, parent and leader reads, book activation, start lesson, tour and language.

- Each table is typed `Record<RuleUnion, tool>`, so a new rule without a tool fails to compile.
- `intent-tools.test.ts` checks that every tool exists and is open to its role.
- It also walks a phrase bank for six role contexts through `routeByRules`, and asserts that each decision's tools are in that role's model tool set.

### Softer grounding (model routing only)

`groundingCheck(…, { mode: "soft" })`:

- **Blocked:**
  - an email, phone number or URL that the tools did not return. This is unchanged. The question never counts as support for these.
  - **A person's name** that is not in the tools, the question or her own context entities:
    - a capitalised word after an honorific ("Mrs Tan", "Cikgu Bakar");
    - a capitalised word next to a kin or role word ("Amir's mother", "learners: Chandra, Cahya");
    - names in a list followed by a person-predicate ("Zara dan Zul berisiko", "… are at risk").
  - **A number** that the support does not carry, but only in a sentence that cites tool data. Tool data means a data word (students, score, %, seats, RM, marking …) or a distinctive word a tool returned.
- **Never blocked:**
  - product words, SK's own phrasing, days, months and languages;
  - any other capitalised word: topics, titles and places. The "any capitalised word" rule is dropped in this mode.
  - a number in SK's own phrasing ("I can help in 3 ways").
- **With no tool at all**, the sentences that pass stand, as supplementary text. The ones that fail are dropped.
- **A tool's own line.** A tool that answered with its own line ("Grade 6 is outside your scope", "No one is at risk") counts as an answer. A failed tool's own line is said instead of "I have nothing on that".

Rules routing keeps the strict check unchanged.

**Known consequence:** in soft mode a RAG answer may add general knowledge that is not in the passages, such as a historical name or year, when the sentence carries no data word and no tool word. Prompt rule 3 still asks the model to mark such text as supplementary. The strict mode dropped these sentences.

### Prompt caching

The Anthropic provider puts `cache_control: ephemeral` on the **last tool** as well as on the system block. The render order is tools → system → messages.

SK's system prompt changes every turn because of its context line. The tool list does not change for the same role and context, so it stays cached. The tool order is the registry order.

`done.usage` now carries `cacheReadTokens` and `cacheWriteTokens` when the API reports them. Caches are per model, so Haiku and Sonnet each warm their own.

## Measurement

### Per-turn timing line (both routings)

```
sk-shell.turn timing {"turnId":"…","routing":"model","route":"model","role":"teacher","region":"ap-southeast-2",
  "model":{"tier":"fast","models":["claude-haiku-5-5"],"escalated":null},"ttftMs":412,"firstTextMs":431,
  "totalMs":980,"rounds":2,"toolCalls":1,"tokens":{"input":5210,"output":64,"cacheRead":4800,"cacheWrite":0}}
```

The `route` field takes these values:

- `walk`, `offer` or `book` for the pre-model rules;
- `model`, or `model>student_knowledge`, `model>lesson_plan` or `model>tutor` for the hand-offs;
- the rules intent in rules routing (`tour`, `navigate`, `teach`, `ask` …).

The other fields:

- `ttftMs` is the time to the model's first answer token.
- `firstTextMs` is the time to the first text the user sees.
- `region` is SK's Bedrock region, or `anthropic`.

No env value is ever logged.

### Gates (scripted: free, no network)

```
node scripts/sk-gates.ts                      # both routings, then the comparison table
node scripts/sk-gates.ts --routing model      # one routing
```

**Under model routing every item reaches the model.** A bank item that the rules answer gets the script an honest model would follow: the capability and arguments the rules chose, then that tool's summary (`scriptFromRules`). Unsupported items keep their deliberate fabrications, so the guards are still measured.

The CI subset (`gates.test.ts`) runs under both routings.

Scripted comparison, 2026-10-30, 150 items: 60 principal, 60 coordinator and 30 unsupported.

| Routing | Grounded pass | Leak-free | Action claims | Wrong action | Unsupported refused | Stub model calls | Model turns | Avg rounds / model turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rules | 120/120 (100 %) | 150/150 (100 %) | 0 | 0 | 30/30 (100 %) | 101 | 52/150 | 1.9 |
| model | 120/120 (100 %) | 150/150 (100 %) | 0 | 0 | 30/30 (100 %) | 297 | 150/150 | 2 |

Prompt volume, with no caching assumed: about 0.68 M input tokens for rules routing and about 2.07 M for model routing. With the tool definitions cached, most of the model-routing input is cache reads.

### A small live comparison: not run

A live run is **paid**, and it needs the founder's word. Steps:

1. Check the current Bedrock prices for **Sonnet 5.5** in the region SK will use. The estimate takes one price pair, so pass Sonnet's prices as the upper bound; Haiku rounds cost less.
2. Print the estimate. This spends nothing:
   ```
   node scripts/sk-gates.ts --model live --routing model --subset ci --price-in <USD/MTok> --price-out <USD/MTok>
   ```
3. With the founder's approval, run it for each routing. Each run is 12 items:
   ```
   SK_GATES_LIVE=1 node scripts/sk-gates.ts --model live --routing rules --subset ci --price-in … --price-out … --env-file .env.local --yes
   SK_GATES_LIVE=1 node scripts/sk-gates.ts --model live --routing model --subset ci --price-in … --price-out … --env-file .env.local --yes
   ```
4. Compare the two `reports/sk-gates/sk-gates-live-<routing>-*.md` reports: grounded, leaks, claims, wrong action and the measured tokens. For latency, read the `sk-shell.turn timing` lines.

Without `--subset ci`, the run covers the full 150-item bank.

## Rollback

Set `SK_ROUTING=rules`, which ignores the allow-list, or clear `SK_MODEL_FIRST_EMAILS`. No deploy is needed. Rules routing is the code path from before this change: the extra work is the timing log line and the tool cache breakpoint.

## Files

- `src/sk/shell/routing.ts`: the switch, `chooseModel`, `SkModelProvider` (escalation), the pre-model book rule and the hand-offs.
- `src/sk/shell/intent-tools.ts`: the rule-intent → tool inventory.
- `src/sk/shell/prompt.ts`: soft grounding, and the `MODEL-FIRST` prompt block (model routing only).
- `src/app/api/sk/shell/turn/route.ts`: the model path and the timing line.
- `src/utils/assistant/providers/anthropic.ts`: tool caching, cache-token usage and the SK target.
- `src/sk/claude-target.ts` and `src/utils/claude-backend.ts`: SK's Bedrock region and model overlay.
- `src/sk/gates/*` and `scripts/sk-gates.ts`: the gates under both routings.
