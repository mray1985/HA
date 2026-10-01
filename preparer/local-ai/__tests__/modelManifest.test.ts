import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVED_MODELS, approvedModel, modelFilePath, type ModelFile } from '../src/modelManifest.js';
import { checkModelFile } from '../src/modelFiles.js';

describe('approved model manifest', () => {
  it('names one reader and one second reader, each with weights and a vision projector', () => {
    expect(approvedModel('reader').name).toBe('Qwen3.5-0.8B');
    expect(approvedModel('second_reader').name).toBe('GLM-OCR');
    for (const m of APPROVED_MODELS) {
      for (const f of [m.weights, m.projector]) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(f.sizeBytes).toBeGreaterThan(100_000_000);
      }
      expect(['Apache-2.0', 'MIT']).toContain(m.license);
    }
  });

  it('keeps every model under one billion parameters on CPU (work order constraint)', () => {
    // Q4_K_M weights of a sub-1B model are well under 1 GB.
    for (const m of APPROVED_MODELS) expect(m.weights.sizeBytes).toBeLessThan(1_000_000_000);
  });
});

describe('checkModelFile', () => {
  const bytes = Buffer.from('not a real model, but a real file');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file: ModelFile = { repo: 'test-org/test-GGUF', revision: '0'.repeat(40), file: 'model.gguf', sizeBytes: bytes.length, sha256 };

  function withFile(content: Buffer | null, run: (dir: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'hatax-models-'));
    if (content) {
      const path = join(dir, modelFilePath(file));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it('accepts only a file whose size and SHA-256 both match', async () => {
    await withFile(bytes, async (dir) => expect((await checkModelFile(dir, file)).state).toBe('ok'));
    await withFile(null, async (dir) => expect((await checkModelFile(dir, file)).state).toBe('missing'));
    await withFile(Buffer.concat([bytes, Buffer.from('!')]), async (dir) => expect((await checkModelFile(dir, file)).state).toBe('wrong_size'));
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 1;
    await withFile(tampered, async (dir) => expect(await checkModelFile(dir, file)).toMatchObject({ state: 'wrong_hash' }));
  });
});
