import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'hatax-models-'));
process.env.HATAX_DB_PATH = join(dir, 'auth.db');
process.env.JWT_SECRET = 'test-jwt-secret';
// No runtime installed: the routes must say so, never pretend to read.
process.env.HATAX_MODELS_DIR = join(dir, 'models');
process.env.HATAX_LLAMA_SERVER = join(dir, 'missing', 'llama-server.exe');

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { authRoutes } = await import('../src/routes/auth.js');
const { modelRoutes } = await import('../src/routes/models.js');
const { closeDatabase } = await import('../src/database.js');

let server: Server;
let base: string;
let token = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/models', express.json({ limit: '25mb' }));
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/models', modelRoutes);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'preparer@example.com', password: 'password1', name: 'Preparer', role: 'taxpayer' }),
  });
  token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const PAGE = { imagePng: 'iVBORw0KGgo=', prompt: 'Fill in this JSON', name: 'form', jsonSchema: { type: 'object' } };

describe('model routes', () => {
  it('are for signed-in preparers only', async () => {
    expect((await fetch(`${base}/api/models/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/models/reader/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PAGE) })).status).toBe(401);
  });

  it('report the runtime unavailable when llama-server is not installed', async () => {
    const res = await fetch(`${base}/api/models/status`, { headers: auth() });
    expect(res.status).toBe(200);
    const status = (await res.json()) as { available: boolean; reason: string; models: Array<{ name: string; usable: boolean }> };
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/llama-server is not installed/);
    expect(status.models.map((m) => m.name)).toEqual(['Qwen3.5-0.8B', 'GLM-OCR']);
  });

  it('take only a page image and a grammar request', async () => {
    const bad = await fetch(`${base}/api/models/reader/read`, { method: 'POST', headers: auth(), body: JSON.stringify({ ...PAGE, imagePng: 'not base64!', name: 'x y' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toMatch(/imagePng must be base64.*name must be/);
    expect((await fetch(`${base}/api/models/chat/read`, { method: 'POST', headers: auth(), body: JSON.stringify(PAGE) })).status).toBe(404);
  });

  it('fail a read plainly, with its run record, when the model cannot load', async () => {
    const res = await fetch(`${base}/api/models/reader/read`, { method: 'POST', headers: auth(), body: JSON.stringify(PAGE) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string }; run: { ok: boolean; modelId: string; weightsSha256: string } };
    expect(body.error.code).toBe('MODEL_UNAVAILABLE');
    expect(body.error.message).toMatch(/model files are not verified/);
    expect(body.run).toMatchObject({ ok: false, modelId: 'qwen3.5-0.8b', weightsSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
