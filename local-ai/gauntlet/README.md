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
   would have been applied without review.
7. `checkboxes.ts` scores the deterministic checkbox reader alone on every
   case and page variant; no model is involved.
8. `run-tools.ts` scores tool-calling models on §56 metrics: tool selection,
   missing / extra / wrong / invalid arguments, hallucinated tools, duplicate
   calls, and unknown facts passed as values.

```bash
node local-ai/gauntlet/render-cases.mjs --dpi 150 --suffix -150dpi
node local-ai/gauntlet/render-scans.mjs
npx tsx local-ai/gauntlet/run.ts --model <gguf> --mmproj <mmproj.gguf> \
  --second-model <glm-ocr.gguf> --second-mmproj <glm-mmproj.gguf> --style plain \
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

### Checkbox reader alone (`checkboxes.ts`, 21 checkboxes per variant)

| Page | Right | Unknown (review) | Wrong |
|---|---|---|---|
| Native PDF, 200 dpi | 21 | 0 | 0 |
| Office scan | 20 | 1 | 0 |
| Fax | 17 | 4 | 0 |
| Faded copy | 14 | 7 | 0 |

Most unknowns are labels OCR cannot read at all. W-2 box 13's labels are never
readable on a scan, so its squares are found from the table cell below box 11
(or of box 13 / above box 14a), which must hold exactly three squares.

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
