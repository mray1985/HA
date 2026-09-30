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
5. `run-tools.ts` scores tool-calling models on §56 metrics: tool selection,
   missing / extra / wrong / invalid arguments, hallucinated tools, duplicate
   calls, and unknown facts passed as values.

```bash
node local-ai/gauntlet/render-cases.mjs --dpi 150 --suffix -150dpi
npx tsx local-ai/gauntlet/run.ts --model <gguf> --mmproj <mmproj.gguf> --image-suffix -150dpi --style plain
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

Findings that shaped the product code:

- Model-reported coordinates are invented (uniform grids), so no model is asked
  for a location. `pageEvidence.locateValue` finds each value in the PDF text
  layer or OCR word boxes instead.
- No model reliably read checkboxes or the W-2 box 12 code.
  `pageEvidence.readCheckbox` and `readBox12Code` / `readBox12Entry` read them
  deterministically; a checkbox the page cannot settle routes to review.
- A JSON grammar that forbids `""` made a model write `0` into every blank box.
  Grammars must always allow an explicit blank.

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
