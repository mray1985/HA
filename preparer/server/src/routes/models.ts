/**
 * Local model routes (signed-in preparers only):
 *   GET  /api/models/status        — model files, loaded model, memory, latency
 *   POST /api/models/:role/read    — one grammar-constrained page read
 *
 * The models run on this computer (ModelRuntime); nothing leaves it. A read
 * takes only a page image, a prompt and the JSON grammar — not arbitrary
 * model access.
 */

import express, { type Request, type Response } from 'express';
import { modelRuntime } from '../modelRuntime.js';
import { requireAuth } from './auth.js';

const router = express.Router();

const ROLES = new Set(['reader', 'second_reader']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

router.get('/status', requireAuth, async (_req: Request, res: Response) => {
  res.json(await modelRuntime.status());
});

router.post('/:role/read', requireAuth, async (req: Request, res: Response) => {
  const role = String(req.params.role);
  if (!ROLES.has(role)) {
    res.status(404).json({ error: { message: `No model with role ${role}`, code: 'NOT_FOUND' } });
    return;
  }
  const { imagePng, prompt, name, jsonSchema } = (req.body ?? {}) as Record<string, unknown>;
  const problems = [
    typeof imagePng !== 'string' || imagePng.length === 0 || !BASE64.test(imagePng) ? 'imagePng must be base64 PNG data' : null,
    typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 20_000 ? 'prompt must be text of at most 20,000 characters' : null,
    typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) ? 'name must be a short identifier' : null,
    !jsonSchema || typeof jsonSchema !== 'object' || Array.isArray(jsonSchema) ? 'jsonSchema must be a JSON schema object' : null,
  ].filter(Boolean);
  if (problems.length > 0) {
    res.status(400).json({ error: { message: problems.join('; '), code: 'INVALID_REQUEST' } });
    return;
  }
  try {
    const { content, run } = await modelRuntime.read(role as 'reader' | 'second_reader', {
      imagePng: imagePng as string,
      prompt: prompt as string,
      name: name as string,
      jsonSchema: jsonSchema as Record<string, unknown>,
    });
    res.json({ content, run });
  } catch (err) {
    const run = (err as { run?: unknown }).run;
    res.status(503).json({ error: { message: err instanceof Error ? err.message : 'The model could not read the page', code: 'MODEL_UNAVAILABLE' }, ...(run ? { run } : {}) });
  }
});

export { router as modelRoutes };
