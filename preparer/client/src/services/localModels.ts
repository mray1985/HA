/**
 * The app's local model runtime, as the browser sees it: its status, and a
 * VisionModel that reads a page through the signed-in server route. The
 * models run on this computer; the page never leaves it.
 */

import type { ModelRole, VisionModel } from '@hatax/local-ai';

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
  return `${base}${path}`;
}

export interface ModelFileState {
  state: 'ok' | 'missing' | 'wrong_size' | 'wrong_hash';
  path: string;
}

export interface LocalModelStatus {
  role: ModelRole;
  id: string;
  name: string;
  quantization: string;
  revision: string;
  weights: ModelFileState | null;
  projector: ModelFileState | null;
  usable: boolean;
  loaded: boolean;
  memoryBytes?: number;
  calls: number;
  averageMs?: number;
  lastError?: string;
}

export interface LocalRuntimeStatus {
  available: boolean;
  reason?: string;
  models: LocalModelStatus[];
}

/** The runtime's status, or null when the server has no model routes (a plain web deployment). */
export async function fetchModelStatus(): Promise<LocalRuntimeStatus | null> {
  try {
    const res = await fetch(apiUrl('/api/models/status'), { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as LocalRuntimeStatus;
  } catch {
    return null;
  }
}

/** Provenance of one model call, as the runtime recorded it (§42). */
export interface ModelRunRecord {
  runId: string;
  role: ModelRole;
  modelId: string;
  modelName: string;
  quantization: string;
  revision: string;
  weightsSha256: string;
  startedAt: string;
  ms: number;
  ok: boolean;
  error?: string;
}

/** A VisionModel over the local runtime; every call's run record is kept. */
export function localVisionModel(runs: ModelRunRecord[]): VisionModel {
  return {
    async chat(role, request) {
      const res = await fetch(apiUrl(`/api/models/${role}/read`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = (await res.json().catch(() => ({}))) as { content?: string; run?: ModelRunRecord; error?: { message?: string } };
      if (body.run) runs.push(body.run);
      if (!res.ok || typeof body.content !== 'string') {
        throw new Error(body.error?.message ?? `The ${role === 'reader' ? 'reader' : 'second reader'} could not read the page (HTTP ${res.status}).`);
      }
      return { content: body.content, ms: body.run?.ms ?? 0, ...(body.run ? { runId: body.run.runId } : {}) };
    },
  };
}
