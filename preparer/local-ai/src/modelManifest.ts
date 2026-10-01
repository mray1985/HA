/**
 * The models the preparer app ships and runs (llama.cpp `llama-server`, CPU).
 *
 * Only these files are loaded. Each is pinned by size and SHA-256 — both
 * checked against the Hugging Face LFS record of the named repository at the
 * named revision — and carries its license and its role in the pipeline.
 * Chosen by the model gauntlet (`gauntlet/README.md`), where the rejected
 * candidates and the reasons are recorded.
 *
 * Browser-safe data only; file checks live in `modelFiles.ts` (Node).
 */

export type ModelRole =
  /** Primary document reader: classifies the form and fills its extraction template. */
  | 'reader'
  /** Second reader: re-reads only the boxes the page could not confirm (§33). */
  | 'second_reader';

export interface ModelFile {
  /** Hugging Face repository the file is published in. */
  repo: string;
  /** Repository commit the hash was checked at. */
  revision: string;
  /** File name in the repository, and under `models/<repo>/` on disk. */
  file: string;
  sizeBytes: number;
  sha256: string;
}

export interface ApprovedModel {
  id: string;
  name: string;
  role: ModelRole;
  /** Base model the quantization is made from. */
  baseModel: string;
  license: 'Apache-2.0' | 'MIT';
  quantization: string;
  weights: ModelFile;
  /** Vision projector (mmproj) that lets the model read page images. */
  projector: ModelFile;
}

export const APPROVED_MODELS: readonly ApprovedModel[] = [
  {
    id: 'qwen3.5-0.8b',
    name: 'Qwen3.5-0.8B',
    role: 'reader',
    baseModel: 'Qwen/Qwen3.5-0.8B',
    license: 'Apache-2.0',
    quantization: 'Q4_K_M',
    weights: {
      repo: 'unsloth/Qwen3.5-0.8B-GGUF',
      revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
      file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
      sizeBytes: 532_517_120,
      sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517',
    },
    projector: {
      repo: 'unsloth/Qwen3.5-0.8B-GGUF',
      revision: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0',
      file: 'mmproj-F16.gguf',
      sizeBytes: 204_987_232,
      sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453',
    },
  },
  {
    id: 'glm-ocr',
    name: 'GLM-OCR',
    role: 'second_reader',
    baseModel: 'zai-org/GLM-OCR',
    license: 'MIT',
    quantization: 'Q4_K_M',
    weights: {
      repo: 'mradermacher/GLM-OCR-GGUF',
      revision: '657782bc498bb78f0c6f4828ce625c86b767dadf',
      file: 'GLM-OCR.Q4_K_M.gguf',
      sizeBytes: 548_515_136,
      sha256: 'bb27f2451f0f1b13491e04e0664cd946438a4677c32acf8ecfef79f68e862de1',
    },
    projector: {
      repo: 'ggml-org/GLM-OCR-GGUF',
      revision: '65a42de1148dbed2297e922b5dbc7d9b70c36578',
      file: 'mmproj-GLM-OCR-Q8_0.gguf',
      sizeBytes: 484_403_648,
      sha256: '9c4b58e33e316ed142eb5dcb41abec3844d3e6e5dc361ffb782c3fa9d175141f',
    },
  },
];

export function approvedModel(role: ModelRole): ApprovedModel {
  return APPROVED_MODELS.find((m) => m.role === role)!;
}

/** Path of a model file relative to the models folder: `<repo>/<file>`. */
export function modelFilePath(file: ModelFile): string {
  return `${file.repo}/${file.file}`;
}
