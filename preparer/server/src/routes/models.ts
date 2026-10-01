/**
 * Local model routes (signed-in preparers only):
 *   GET  /api/models/status        — model files, loaded model, memory, latency
 *   POST /api/models/:role/read    — one grammar-constrained page read
 *   POST /api/models/reader/ask    — one grammar-constrained answer about text
 *                                    (a client's reply, work order §25)
 *
 * The models run on this computer (ModelRuntime); nothing leaves it. A call
 * takes only a page image or text, a prompt and the JSON grammar — not
 * arbitrary model access.
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

function requestProblems(body: Record<string, unknown>, withImage: boolean): string[] {
  const { imagePng, prompt, name, jsonSchema } = body;
  return [
    withImage && (typeof imagePng !== 'string' || imagePng.length === 0 || !BASE64.test(imagePng)) ? 'imagePng must be base64 PNG data' : null,
    !withImage && imagePng !== undefined ? 'a question about text takes no image' : null,
    typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 20_000 ? 'prompt must be text of at most 20,000 characters' : null,
    typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) ? 'name must be a short identifier' : null,
    !jsonSchema || typeof jsonSchema !== 'object' || Array.isArray(jsonSchema) ? 'jsonSchema must be a JSON schema object' : null,
  ].filter((p): p is string => p !== null);
}

async function runModel(res: Response, role: 'reader' | 'second_reader', body: Record<string, unknown>): Promise<void> {
  try {
    const { content, run } = await modelRuntime.read(role, {
      ...(typeof body.imagePng === 'string' ? { imagePng: body.imagePng } : {}),
      prompt: body.prompt as string,
      name: body.name as string,
      jsonSchema: body.jsonSchema as Record<string, unknown>,
    });
    res.json({ content, run });
  } catch (err) {
    const run = (err as { run?: unknown }).run;
    res.status(503).json({ error: { message: err instanceof Error ? err.message : 'The model could not answer', code: 'MODEL_UNAVAILABLE' }, ...(run ? { run } : {}) });
  }
}

router.post('/:role/read', requireAuth, async (req: Request, res: Response) => {
  const role = String(req.params.role);
  if (!ROLES.has(role)) {
    res.status(404).json({ error: { message: `No model with role ${role}`, code: 'NOT_FOUND' } });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const problems = requestProblems(body, true);
  if (problems.length > 0) {
    res.status(400).json({ error: { message: problems.join('; '), code: 'INVALID_REQUEST' } });
    return;
  }
  await runModel(res, role as 'reader' | 'second_reader', body);
});

// Only the reader answers questions about text; the second reader is a page reader.
router.post('/reader/ask', requireAuth, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const problems = requestProblems(body, false);
  if (problems.length > 0) {
    res.status(400).json({ error: { message: problems.join('; '), code: 'INVALID_REQUEST' } });
    return;
  }
  await runModel(res, 'reader', body);
});

export { router as modelRoutes };
