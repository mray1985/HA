# Stress run

Seven synthetic 2025 households (SSN area 000 is never issued) and 23
documents filled on the official IRS blanks in `../forms`: W-2s (one a phone
photo of another, one for 2024, one a scan with no text layer), 1099-INT, -DIV,
-G, -R, -NEC, -MISC, -B, -OID, -C, -SA, a 1098 and a 1098-T, and each
client's reply (a spouse and children, a filing status, a residency, a
business expense, the HSA and cancelled-debt answers).

A preparer drops every document on the dashboard at once, places what the
intake could not, and pastes each reply; the run records what the app did
and `score.ts` checks it against `truth.json`.

```sh
# from preparer/local-ai/gauntlet/stress: the documents (docs/) and truth.json
node make-docs.mjs

# from preparer/client: the run, with the local models (about 20 minutes on CPU)
E2E_MODELS=1 STRESS_DIR="$(pwd)/../local-ai/gauntlet/stress" npx playwright test e2e/stress-ai.spec.ts --project=chromium --reporter=line

# from preparer/: the score, written to run/score.md
npx tsx local-ai/gauntlet/stress/score.ts local-ai/gauntlet/stress
```

The run is not part of the suite: `stress-ai.spec.ts` skips unless
`E2E_MODELS` and `STRESS_DIR` are set. Do not edit `client/src`, `local-ai/src`
or `shared/src` while it runs — the dev server reloads the app and the run
starts over.
