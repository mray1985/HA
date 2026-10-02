/**
 * Node-only: checks the approved model files on disk against the manifest.
 * A file is usable only when its size and SHA-256 match exactly; anything
 * else (missing, truncated, a different build) is reported, never loaded.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { modelFilePath, type ModelFile } from './modelManifest.js';

export type ModelFileStatus =
  | { state: 'ok'; path: string }
  | { state: 'missing'; path: string }
  | { state: 'wrong_size'; path: string; sizeBytes: number }
  | { state: 'wrong_hash'; path: string; sha256: string };

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

/** Check one file. The size is checked first, so a wrong file is rejected without hashing it. */
export async function checkModelFile(modelsDir: string, file: ModelFile): Promise<ModelFileStatus> {
  const path = join(modelsDir, modelFilePath(file));
  if (!existsSync(path)) return { state: 'missing', path };
  const sizeBytes = statSync(path).size;
  if (sizeBytes !== file.sizeBytes) return { state: 'wrong_size', path, sizeBytes };
  const sha256 = await sha256File(path);
  return sha256 === file.sha256 ? { state: 'ok', path } : { state: 'wrong_hash', path, sha256 };
}
