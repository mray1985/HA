# Model gauntlet

Measures local models on real IRS forms with independently known values
(work order §54–§57). Every result below was produced on CPU only, on an AMD
Ryzen AI 7 350 with 15 GB RAM, using llama.cpp `llama-server` build 11262.

## How it works

1. `forms/` holds official blank IRS PDFs downloaded from irs.gov.
2. `cases/*.json` fill a form's Copy B with synthetic values (SSN area `000`,
   never issued) and record the expected tax-tool arguments, the expected text
   per box, and the boxes that must stay blank.
3. `render-cases.mjs` fills, flattens and rasterizes each case with pdf.js — the
   same rasterizer the preparer app uses.
4. `run.ts` runs a vision model end to end through the product modules:
   grammar-constrained classification → grammar-constrained template extraction
   (`formSchemas`) → deterministic page evidence (`formEvidence`) →
   `mapBoxesToTool` → `extractStructuredFields`, then scores tool arguments,
   located values, and any value reported for a blank box.
5. `render-scans.mjs` degrades each case into an office scan (300 dpi, 1.2°
   skew, noise, JPEG, blur), a fax (200 dpi, -2.5° skew, 1-bit threshold) and
   a faded copy (200 dpi, 45% contrast). `run.ts --scan <variant>` reads them
   with no text layer: Tesseract straightens the page and supplies the word
   boxes, and the model sees the straightened page.
6. With `--second-model`, a second document model (GLM-OCR) reads only the
   boxes the page could not confirm and the boxes the primary model left blank
   although the page prints an amount (§33, `secondReading.ts`). Every tool
   value is scored as confirmed (by the page or the second model), recovered,
   unconfirmed, conflict or missed; "confirmed wrong" counts wrong values that
   would have been applied without review, judged as the tool call parses them
   (a fax that lost a decimal point, "14 21", is unreadable and left for the
   preparer, not 1421). Such readings are counted as "unreadable".
7. `checkboxes.ts` scores the deterministic checkbox reader alone on every
   case and page variant; no model is involved.
8. `run-tools.ts` scores tool-calling models on §56 metrics: tool selection,
   missing / extra / wrong / invalid arguments, hallucinated tools, duplicate
   calls, and unknown facts passed as values.
9. `run-replies.ts` and `run-notes.ts` score how client replies and notes are
   read (see Client replies and Client notes).

```bash
node local-ai/gauntlet/render-cases.mjs --dpi 150 --suffix -150dpi
node local-ai/gauntlet/render-scans.mjs
npx tsx local-ai/gauntlet/run.ts --model <gguf> --mmproj <mmproj.gguf> \
  --second-model <glm-ocr.gguf> --second-mmproj <glm-mmproj.gguf> \
  --image-suffix -150dpi            # or: --scan scan|fax|faded
npx tsx local-ai/gauntlet/checkboxes.ts
npx tsx local-ai/gauntlet/run-tools.ts --model <gguf>
```

Model files live in the gitignored `models/` directory. Each was verified
against the Hugging Face LFS SHA-256 before use.

## Document reading (5 cases: W-2, 1099-INT, 1099-NEC, 1099-R, 1098)

Tool arguments are counted over the 31 arguments that have a tax tool today
(the 1098's 6 arguments wait on `add_mortgage_interest`).

| Model (Q4_K_M) | Size | Classified | Tool args | Invented values | s/page |
|---|---|---|---|---|---|
| **Qwen3.5-0.8B** (unsloth quant, Apache-2.0) + page evidence | 0.8B | 5/5 | 31/31 | 0 | 38 |
| **GLM-OCR** (mradermacher quant, ggml-org mmproj, MIT) + page evidence | 0.9B | 5/5 | 31/31 | 0 | 66 |
| Qwen3.5-4B (unsloth) | 4B | 5/5 | 30/31 | 0 | 138 — too large for target machines |
| PaddleOCR-VL-1.6 (mradermacher) | 0.9B | 5/5 | 4/31 | 25 | 25 — invents values |
| LFM2.5-VL-450M (LiquidAI) | 0.45B | 5/5 | 3/31 | 1 | 14 — cannot read fine print |
| Granite Docling 258M (Q4_K_M and Q8_0) | 0.26B | — | — | — | loops on W-2, drops the money column |
| hsarfraz/donut-irs-tax-docs-classifier | — | — | — | — | labels only W-2 / 1040 family; a W-2 came back `other_misc` |

### All seven Phase 1 forms (work order §63)

With 1099-DIV and 1098-T cases added and every Phase 1 form wired to a tool
(1098 → `add_mortgage_interest`, 1098-T → `add_education_expense`,
SSA-1099 → `add_ssa_1099`; SSA-1099 has no official fillable blank, so it is
covered by unit tests):

Qwen3.5-0.8B reads, GLM-OCR is the second reader, page evidence throughout:

| Page | Classified | Tool args | Invented | Confirmed wrong | Confirmed by page / by GLM-OCR | s/page |
|---|---|---|---|---|---|---|
| Native PDF, 150 dpi | 7/7 | **55/55** (model alone 49) | 0 | 0 | 50 / 0 | 35 |
| Office scan | 7/7 | **55/55** (model alone 48) | 0 | 0 | 39 / 11, 1 recovered | 83 |
| Fax | 7/7 | 54/55 (model alone 48) | 0 | 0 | 34 / 16, 1 recovered | 83 |
| Faded copy | 7/7 | 48/55 (model alone 47) | 0 | 0 | 26 / 21 | 91 |

The native run scored 54/55 before one fix, measured in that run and
confirmed by replaying its saved output: the model copied the 1099-INT box 1
amount into "Payer's RTN" as well, and the page token went to the box that
comes first in form order. It now goes to the box whose printed label it sits
under.

Every miss is an explicit unknown routed to review, never a wrong value: on
the fax the 1098-T half-time checkbox label is unreadable; on the faded copy
four checkboxes go unread (three labels OCR cannot read, one square it cannot
find), OCR misses the W-2 box 12 entry and a state
code, and the model left the 1099-DIV withholding blank. "Recovered" is a box
the model left blank that GLM-OCR and the page's own text both read (1099-DIV
box 4, `0.00`). The 1099-DIV Section 199A amount (box 5, no engine field)
routes to review.

### Every case through the product reader (`src/documentReader.ts`)

`run.ts` reads each page with the app's own pipeline module (the same calls
the app makes through its model runtime). All 15 cases, native 150 dpi:

| Classified | Tool args | Invented | Confirmed wrong | s/page |
|---|---|---|---|---|
| 15/15 | **105/105** (model alone 92) | 0 | 0 | 42 |

### Work order §16 forms (7 cases, Qwen3.5-0.8B + page evidence + GLM-OCR)

1099-B, 1099-C, 1099-G, 1099-MISC, 1099-OID, 1099-Q and 1099-SA, each filled on
its irs.gov Copy B with synthetic values, read from the native 150 dpi render.

| Page | Classified | Tool args | Invented | Confirmed wrong | s/page |
|---|---|---|---|---|---|
| Native PDF, 150 dpi | 7/7 | **41/41** (model alone 33) | 0 | 0 | 36 |

The 8 arguments the model missed are all checkboxes (1099-B term, collectibles
and basis-reported squares; 1099-Q transfer and beneficiary squares; 1099-C
box 5; 1099-SA account), read by the page. Review items are the boxes no engine
field takes: the 1099-G state refund, its tax year and the box 8 square, and the
1099-OID FATCA square. A value the model wrote into the empty second 1099-MISC
state row was dropped because the page does not print it.

W-2c (Rev. 1-2026, boxes 1–3 corrected, both columns): classified W-2C, 9/9
tool arguments, 0 invented, 0 confirmed wrong, 114 s/page — the second model
reads the paired columns, so it runs on more boxes. Box c ("2025 / W-2") is
compared by its year, so the second model's "2025" confirms it rather than
conflicting.

### §16 forms on scanned, faxed and faded copies

The same seven cases through `run.ts --scan scan|fax|faded`:

| Page | Classified | Tool args | Invented | Confirmed wrong | Unreadable | s/page |
|---|---|---|---|---|---|---|
| Office scan | 7/7 | **40/41** (model alone 34) | 0 | 0 | 0 | 66 |
| Fax | 7/7 | **35/41** (model alone 32) | 0 | 0 | 1 | 102 |
| Faded copy | 7/7 | **36/41** (model alone 33) | 0 | 0 | 0 | 93 |

The W-2c case (boxes 1–3 corrected; it corrects the W-2 in `w2-basic-single`):
9/9 tool arguments on the native page, the scan, the fax and the faded copy,
0 invented, 0 confirmed wrong, 72–125 s/page.

The missed arguments are checkboxes the degraded page no longer shows
plainly (1099-B basis reported and collectibles, 1099-Q transfer squares,
1099-SA account type), left unknown for the preparer; the fax's 1099-B
description lost its period ("40 sh ACME CORP"). The one unreadable value is
the fax's 1099-OID box 4: both readers read "14 21" for 14.21, which the tool
call cannot parse, so it is left for the preparer rather than entered as 1,421.
On the faded copy the two readers disagreed on the 1099-B description ("100
sh." against the page), which holds the form. Fax and faded timings were taken
while other builds ran on the same machine.

### Checkbox reader alone (`checkboxes.ts`)

53 checkboxes per variant: 21 on the seven Phase 1 forms and 32 on the §16
forms (1099-B, 1099-Q, 1099-SA, 1099-C, 1099-G, 1099-MISC, 1099-OID).

| Page | Right (Phase 1 / §16) | Unknown (review) | Wrong |
|---|---|---|---|
| Native PDF, 200 dpi | 53 (21 / 32) | 0 | 0 |
| Office scan | 48 (20 / 28) | 5 | 0 |
| Fax | 34 (17 / 17) | 19 | 0 |
| Faded copy | 31 (14 / 17) | 22 | 0 |

Most unknowns are labels OCR cannot read at all. W-2 box 13's labels are never
readable on a scan, so its squares are found from the table cell below box 11
(or of box 13 / above box 14a), which must hold exactly three squares.

The §16 forms' square positions were measured on the official PDFs (each
checkbox widget's rectangle against its printed label). Two findings:

- Stacked squares (1099-B box 2, 1099-SA box 5, 1099-Q boxes 4 and 5) are
  searched on the label's own line only. Before that, the faded 1099-B read
  the checked long-term square for the short-term label — a wrong reading —
  because the short-term outline had faded out.
- The 1099-Q box 6 square sits alone in its cell's corner, far from the label,
  so it is found by its table cell when the label search finds no square.
  1099-S boxes 6 and 7 print their squares at the end of a dotted leader
  beyond any label search, so they are read from the model only and reviewed.

Findings that shaped the product code:

- Model-reported coordinates are invented (uniform grids), so no model is asked
  for a location. `pageEvidence.locateValue` finds each value in the PDF text
  layer or OCR word boxes instead.
- No model reliably read checkboxes or the W-2 box 12 code.
  `pageEvidence.readCheckbox` and `readBox12Code` / `readBox12Entry` read them
  deterministically; a checkbox the page cannot settle routes to review.
- A JSON grammar that forbids `""` made a model write `0` into every blank box.
  Grammars must always allow an explicit blank.
- A value is confirmed only by the page token that belongs to its box. A token
  on a printed label never counts (1098 box 9 holds "1", which is also box 1's
  number); a W-2 box 12 code only by the code printed beside its own amount
  (every slot prints "Code" vertically, and a model read its "C" into 12a and
  into the empty 12b–12d); a code with no amount is dropped.
- OCR misses tokens, so an amount OCR saw once but two boxes claim leaves the
  second box unconfirmed rather than dropped (a faded W-2's boxes 5 and 16
  were real). On a text layer, which holds every token, the copy is dropped.
- Name/address blocks a model returns on one line get their line breaks back
  from the page, so the payer name is not the whole address.
- Checkboxes: squares are told from letters by size in label ems (measured
  from the label's glyphs, bounded by its width — OCR boxes swell on noisy
  pages), ink on all four edges and all four corners; ruling lines are masked;
  pieces of a broken fax outline are joined; a mark is judged against the
  square's own outline and paper levels. Each rule came from a measured wrong
  or missed reading. Stale renders from before the pdf.js font fix had no
  checkmark glyphs, which once made a 1099-R IRA box look checked for the
  wrong reason; every render was regenerated.

## Tool calling (8 cases)

| Model (Q4_K_M) | Right tool | Exact args | Unknown passed as a value | s/call |
|---|---|---|---|---|
| Qwen3.5-0.8B | 7/8 | 6/8 | 2 (`wages: 0`) | 2.9 |
| LFM2.5-350M | 7/8 | 3/8 | 2 | 1.0 |
| FunctionGemma-270M | 1/8 | 1/8 | — (unparsed format, duplicate keys) | 4.7 |

No model is safe to apply unchecked: Qwen3.5-0.8B passed `wages: 0` for an
unknown wage and invented a 1099-NEC for a 1098. Tool calls are therefore
grounded in the extracted facts (`groundedToolCall.ts`):

- only the tool for the classified form is offered, and a form with no tool is
  never sent to the model;
- each offered argument is a JSON Schema `const` of its extracted value, so the
  grammar cannot produce a value the document does not contain;
- every call is re-verified deterministically before it is applied;
- a client's filing-status answer uses a grammar (five statuses or
  `not_stated`) and is recorded only when the model agrees with a
  deterministic reading of the client's words.

Grounded run, `run-tools.ts --grounded` (17 cases, including 10 client answers):

| Model | Correct | Wrong value | Unknown passed | Hallucinated tool | s/call |
|---|---|---|---|---|---|
| Qwen3.5-0.8B (grounded) | 16/17 | 0 | 0 | 0 | 1.6 |

The one miss is a disagreement ("we want to file together": model said
separately, the words say jointly), which records nothing and leaves the
question to the preparer. Ungrounded, the same model filled
`married_filing_separately` into three answers that state no status.

LiquidAI models (LFM2 / LFM2.5, including the work order's LFM2-1.2B-Tool) are
licensed under LFM Open License v1.0: commercial use is licensed only for
entities under USD 10 million annual revenue.

## Client replies (work order §25)

`run-replies.ts` reads realistic client replies to the questions the app asks
(`src/clientQuestions.ts`: a dependent's months at home and relationship,
residency, days in a state, a 1099-Q's qualified expenses, a 1099-SA's medical
use, the filing status) exactly as the app does: `clientAnswerPrompt` and
`clientAnswerSchema` on the approved reader through `ModelRuntime`, then
`confirmClientAnswer`. A value is recorded only when the model's answer and a
deterministic reading of the client's own words (the whole sentence around the
quoted words) agree. Each question's expected answer is what the words give,
or none when the client is unsure, estimates, or does not answer.

```bash
npx tsx local-ai/gauntlet/run-replies.ts
```

Qwen3.5-0.8B Q4_K_M, 0.8 s per question:

| Replies | Questions | Right | Wrong | Missed | Left open (no answer given) |
|---|---|---|---|---|---|
| Tuned on (the reader was built against these) | 41 | 22 | 0 | 3 | 16 |
| Held out, round 1, first run | 20 | 9 | **1** | 0 | 10 |
| Held out, round 2 (written after round 1's fix, run once) | 17 | 7 | 0 | 5 | 5 |
| Missing-document questions (held out, run once) | 11 | 7 | 0 | 1 | 3 |

Round 1's wrong value: "10 months, she was in the hospital for 2" was recorded
as 10 months. The reader now treats another count beside the months as two
answers, and leaves any months answer that mentions an absence (school,
hospital, camp, service) to the preparer, since a temporary absence counts as
time at home (Pub. 501). Round 1 then gives 9 right, 0 wrong, 11 left open.

Since then the words that answer must also name the question's subject (a
person, state, payer or form) whenever another open question takes the same
kind of answer or the reply names another question's subject: "No, I closed
that Chase account" is not also a "no" about a W-2. This turned round 2's
"Both kids lived with us all year" from two right answers into two left for
the preparer (round 2 now: 5 right, 0 wrong, 7 missed, 5 left open).

The model alone is not safe: it answered 12 months for "she didn't live with
me", "single" for "whatever gets us the bigger refund", "Mother" for "my
daughter" and a month count for "moved in in March" — every one refused
because the client's words do not say it. The misses are the model declining
or misreading, a sentence naming two people ("Leo - 11 months, Maya - 12"), and
words the reader does not take as a yes ("every penny", "About the HSA: yes").

## Client notes (work order §25)

`run-notes.ts` reads notes that answer no open question — a new baby, a
move, an estimated payment — as the app does (`src/clientNotes.ts`): the
reader lists new dependents and estimated payments under one grammar each,
and for every state the note names in full it answers that state's residency
question. Every value is checked against the note's words: a value the words
do not give is dropped (it stays unknown and is asked for), a proposal whose
person, state or payment the words do not give is rejected, and what is left
is offered to the preparer, who adds or dismisses each one.

```bash
npx tsx local-ai/gauntlet/run-notes.ts
```

Qwen3.5-0.8B Q4_K_M, 1.6 s per call, 2.6 calls per note:

| Notes | Proposals right (every field) | Wrong | Missed | Rejected by the words |
|---|---|---|---|---|
| Tuned on (13 notes) | 11 (9) | 0 | 3 | 24 |
| Held out (10 notes, run once) | 7 (7) | 0 | 1 | 14 |

The reader gave an empty list for every state when asked to list states from
51 codes ("I moved from Texas to Louisiana" gave none), so states are asked
one named state at a time. The rejections are the model's inventions: people
named "anyone", "Client" or "Sarah", a puppy and a visiting friend as
dependents, a Louisiana payment "to the IRS", "part-year" for "I work in New
Jersey but live in Pennsylvania". The misses: Texas in "moved from Texas to
Louisiana" (Louisiana was proposed), Nevada in "been in Nevada since", and two
state payments the model gave to the IRS.

## Official form blanks

| File | SHA-256 (first 16) |
|---|---|
| fw2.pdf (2026) | 61eca7c81f16d396 |
| fw2c.pdf | 23344409a2b3fdaa |
| f1099int.pdf (Rev. January 2024) | ee7697c9b2937459 |
| f1099div.pdf | 4ea1de804ff1db92 |
| f1099nec.pdf (Rev. December 2026) | 68a8f00078be6dd6 |
| f1099msc.pdf | 38051fe1cdce8fac |
| f1099r.pdf (2026) | d3de9319bed344f0 |
| f1099g.pdf | 65a416c52508d8a3 |
| f1098.pdf (Rev. April 2025) | 304da9c0f67a46ff |
| f1098t.pdf | f461d17ce14de4ef |
| f1099b.pdf (2026, irs-prior archive) | 31fb17392add5485 |
| f1099k.pdf (Rev. December 2026) | fa3a2b659f7ee13d |
| f1099s.pdf (Rev. December 2026) | f682abe945492be9 |
| f1099c.pdf (Rev. April 2025) | 826fe6811249e38b |
| f1099q.pdf (Rev. April 2025) | 19ad3c80de52d509 |
| f1099sa.pdf (Rev. April 2025) | cc2324629a9bd416 |
| f1099oid.pdf (Rev. January 2024) | cc88d18964125c3f |
