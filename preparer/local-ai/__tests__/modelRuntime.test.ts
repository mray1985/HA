import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { modelFilePath, type ApprovedModel, type ModelFile } from '../src/modelManifest.js';
import { ModelRuntime } from '../src/modelRuntime.js';

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-llama-server.mjs');

function file(name: string, content: string): ModelFile & { content: string } {
  const bytes = Buffer.from(content);
  return { repo: 'test-org/test-GGUF', revision: 'a'.repeat(40), file: name, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content };
}

function model(role: 'reader' | 'second_reader', id: string): ApprovedModel & { files: Array<ModelFile & { content: string }> } {
  const weights = file(`${id}.gguf`, `weights of ${id}`);
  const projector = file(`${id}-mmproj.gguf`, `projector of ${id}`);
  return { id, name: id.toUpperCase(), role, baseModel: id, license: 'MIT', quantization: 'Q4_K_M', weights, projector, files: [weights, projector] };
}

const READER = model('reader', 'reader-model');
const SECOND = model('second_reader', 'second-model');
const PAGE = { imagePng: 'iVBORw0KGgo=', prompt: 'Fill in this JSON', name: 'form', jsonSchema: { type: 'object' } };

let dir = '';
let runtime: ModelRuntime | null = null;

function setup(opts: { tamper?: boolean; idleMs?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'hatax-runtime-'));
  for (const f of [...READER.files, ...SECOND.files]) {
    const path = join(dir, 'models', modelFilePath(f));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, opts.tamper && f === READER.weights ? `${f.content}!` : f.content);
  }
  runtime = new ModelRuntime({
    modelsDir: join(dir, 'models'),
    llamaServer: process.execPath,
    llamaServerArgs: [FAKE_SERVER],
    stateDir: join(dir, 'state'),
    models: [READER, SECOND],
    ...(opts.idleMs ? { idleMs: opts.idleMs } : {}),
  });
  return runtime;
}

afterEach(async () => {
  await runtime?.shutdown();
  runtime = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('ModelRuntime', () => {
  it('reports itself unavailable without llama-server', async () => {
    const r = new ModelRuntime({ modelsDir: tmpdir(), llamaServer: join(tmpdir(), 'no-such-llama-server.exe'), stateDir: tmpdir(), models: [READER] });
    expect(await r.status()).toMatchObject({ available: false, reason: expect.stringMatching(/llama-server is not installed/) });
  });

  it('verifies the files and loads nothing it could not verify', async () => {
    const r = setup({ tamper: true });
    const status = await r.status();
    expect(status.available).toBe(false);
    expect(status.models.find((m) => m.role === 'reader')).toMatchObject({ usable: false, weights: { state: 'wrong_size' } });
    await expect(r.read('reader', PAGE)).rejects.toMatchObject({ message: expect.stringMatching(/not verified/), run: { ok: false, modelId: 'reader-model' } });
  });

  it('reads with each model, keeping one in memory, and records every call', async () => {
    const r = setup();
    const first = await r.read('reader', PAGE);
    expect(JSON.parse(first.content)).toMatchObject({ model: 'reader-model.gguf', schema: 'form' });
    expect(first.run).toMatchObject({ ok: true, role: 'reader', modelId: 'reader-model', weightsSha256: READER.weights.sha256, quantization: 'Q4_K_M' });
    expect((await r.status()).models.map((m) => [m.role, m.loaded])).toEqual([['reader', true], ['second_reader', false]]);

    const second = await r.read('second_reader', PAGE);
    expect(JSON.parse(second.content).model).toBe('second-model.gguf');
    const status = await r.status();
    expect(status.models.map((m) => [m.role, m.loaded, m.calls])).toEqual([['reader', false, 1], ['second_reader', true, 1]]);
    expect(status.models[1]!.averageMs).toBeGreaterThan(0);
  });

  it('runs one call at a time', async () => {
    const r = setup();
    const results = await Promise.all([r.read('reader', PAGE), r.read('reader', PAGE), r.read('reader', PAGE)]);
    expect(results.map((x) => JSON.parse(x.content).maxActive)).toEqual([1, 1, 1]);
  });

  it('stops an idle model and starts it again when needed', async () => {
    const r = setup({ idleMs: 150 });
    await r.read('reader', PAGE);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await r.status()).models.every((m) => !m.loaded)).toBe(true);
    expect(JSON.parse((await r.read('reader', PAGE)).content).model).toBe('reader-model.gguf');
  });

  it('re-uses a verified hash while the file is unchanged', async () => {
    const r = setup();
    await r.status();
    const again = new ModelRuntime({ modelsDir: join(dir, 'models'), llamaServer: process.execPath, llamaServerArgs: [FAKE_SERVER], stateDir: join(dir, 'state'), models: [READER, SECOND] });
    expect((await again.status()).available).toBe(true);
    // Changing a verified file makes it fail verification again.
    writeFileSync(join(dir, 'models', modelFilePath(SECOND.weights)), `${SECOND.weights.content}?`);
    const third = new ModelRuntime({ modelsDir: join(dir, 'models'), llamaServer: process.execPath, llamaServerArgs: [FAKE_SERVER], stateDir: join(dir, 'state'), models: [READER, SECOND] });
    expect((await third.status()).models[1]).toMatchObject({ usable: false });
  });
});
