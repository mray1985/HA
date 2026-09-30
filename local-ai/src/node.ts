// Node-only: Q4_K_M model catalog and local runners (llama-cpp-python /
// transformers via child_process). Missing weights soft-fail to the
// deterministic paths exported from `@hatax/local-ai`.
export * from './modelCatalog.js';
export * from './ggufRuntime.js';
export * from './ggufOcr.js';
export * from './donutClassifier.js';
export * from './lfmToolCaller.js';
