// Browser-safe AI intake for the preparer app (work-order steps 1–9).
// Node-only model runners (llama.cpp / transformers spawn + local weights)
// live in `@hatax/local-ai/node` — never import that entry from a Vite bundle.
export * from './taxFact.js';
export * from './taxTools.js';
export * from './documentIngestion.js';
export * from './documentClassifier.js';
export * from './documentOcr.js';
export * from './structuredExtraction.js';
export * from './factValidation.js';
export * from './toolCaller.js';
