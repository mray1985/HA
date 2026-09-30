// Browser-safe AI intake for the preparer app (work-order steps 1–9).
// Node-only model file checks live in `@hatax/local-ai/node` — never import
// that entry from a Vite bundle.
export * from './taxFact.js';
export * from './taxTools.js';
export * from './returnTools.js';
export * from './recordResolution.js';
export * from './preparerChoices.js';
export * from './holdingPeriod.js';
export * from './w2Corrections.js';
export * from './documentReader.js';
export * from './documentIngestion.js';
export * from './documentClassifier.js';
export * from './documentOcr.js';
export * from './structuredExtraction.js';
export * from './factValidation.js';
export * from './toolCaller.js';
export * from './formSchemas.js';
export * from './pageEvidence.js';
export * from './formEvidence.js';
export * from './secondReading.js';
export * from './toolDefinitions.js';
export * from './groundedToolCall.js';
export * from './clientQuestions.js';
export * from './clientAnswers.js';
export * from './clientNotes.js';
export * from './modelManifest.js';
