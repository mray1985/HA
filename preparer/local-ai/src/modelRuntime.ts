/**
 * ModelManager (work order §8, HA-AI-002): runs the approved models on this
 * computer — CPU only, with no hardware profiling (user decision), and with
 * the model files bundled by the installer (no downloads).
 *
 * - verifies every model file against the manifest (size + SHA-256) before it
 *   is ever loaded; a file's hash is re-used only while its size and
 *   modification time are unchanged;
 * - starts and stops llama.cpp `llama-server` for each model (weights +
 *   vision projector) on a free port bound to 127.0.0.1;
 * - routes each read to its model, one at a time (a CPU runs one well), and
 *   keeps at most `maxLoaded` models in memory — the other is stopped first;
 * - stops a model that has been idle, measures each call's latency, reports
 *   each loaded model's memory, and records every call's provenance (model,
 *   file hash, quantization, revision, latency) for the facts it produces.
 *
 * Node-only (child processes, files). The app's server owns one runtime.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { checkModelFile, type ModelFileStatus } from './modelFiles.js';
import { APPROVED_MODELS, approvedModel, modelFilePath, type ApprovedModel, type ModelFile, type ModelRole } from './modelManifest.js';

export interface ModelRuntimeOptions {
  /** Folder holding the model files as `<repo>/<file>` (modelFilePath). */
  modelsDir: string;
  /** Path to the bundled `llama-server` executable. */
  llamaServer: string;
  /** Folder for the runtime's own records (verified-file hashes). */
  stateDir: string;
  contextSize?: number;
  /** Stop a model after this long without a call. Default 10 minutes. */
  idleMs?: number;
  /** Models kept loaded at once. Default 1 (low-resource CPU machines). */
  maxLoaded?: number;
  startTimeoutMs?: number;
  log?: (message: string) => void;
}

/** One grammar-constrained page read. */
export interface ReadRequest {
  /** The page image, PNG, base64 (no data: prefix). */
  imagePng: string;
  prompt: string;
  /** Name of the JSON schema (for the grammar). */
  name: string;
  jsonSchema: Record<string, unknown>;
}

/** Provenance of one model call (work order §42). */
export interface ModelRunRecord {
  runId: string;
  role: ModelRole;
  modelId: string;
  modelName: string;
  quantization: string;
  revision: string;
  /** SHA-256 of the weights file that ran. */
  weightsSha256: string;
  startedAt: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface ModelStatus {
  role: ModelRole;
  id: string;
  name: string;
  license: string;
  quantization: string;
  revision: string;
  weights: ModelFileStatus | null;
  projector: ModelFileStatus | null;
  /** Both files verified. */
  usable: boolean;
  loaded: boolean;
  pid?: number;
  port?: number;
  loadMs?: number;
  /** Working set of the loaded model's process. */
  memoryBytes?: number;
  calls: number;
  averageMs?: number;
  lastUsedAt?: string;
  lastError?: string;
}

export interface RuntimeStatus {
  available: boolean;
  reason?: string;
  models: ModelStatus[];
}

interface Loaded {
  child: ChildProcess;
  port: number;
  loadMs: number;
  lastUsed: number;
}

interface Stats {
  calls: number;
  totalMs: number;
  lastUsedAt?: string;
  lastError?: string;
}

type VerificationCache = Record<string, { size: number; mtimeMs: number; sha256: string }>;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Working set of a process, in bytes (Windows: tasklist; elsewhere /proc). */
export async function processMemoryBytes(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(undefined);
        // "llama-server.exe","1234","Console","1","1,234,567 K"
        const kb = /"([\d.,\s]+)\s*K"\s*$/m.exec(stdout.trim())?.[1]?.replace(/[^\d]/g, '');
        resolve(kb ? Number(kb) * 1024 : undefined);
      });
    });
  }
  try {
    const kb = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return kb ? Number(kb) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export class ModelRuntime {
  private readonly opts: Required<Omit<ModelRuntimeOptions, 'log'>> & { log: (m: string) => void };
  private readonly loaded = new Map<ModelRole, Loaded>();
  private readonly stats = new Map<ModelRole, Stats>();
  private readonly files = new Map<string, ModelFileStatus>();
  private verified: Promise<void> | null = null;
  /** Calls run one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: ModelRuntimeOptions) {
    this.opts = {
      contextSize: 8192,
      idleMs: 10 * 60_000,
      maxLoaded: 1,
      startTimeoutMs: 300_000,
      log: () => {},
      ...options,
    };
  }

  /** Why the runtime cannot run at all (no llama-server), or null. */
  unavailableReason(): string | null {
    return existsSync(this.opts.llamaServer) ? null : `llama-server is not installed (${this.opts.llamaServer})`;
  }

  private cachePath(): string {
    return join(this.opts.stateDir, 'model-verification.json');
  }

  private async checkFile(file: ModelFile): Promise<ModelFileStatus> {
    const path = join(this.opts.modelsDir, modelFilePath(file));
    let cache: VerificationCache = {};
    try { cache = JSON.parse(readFileSync(this.cachePath(), 'utf8')) as VerificationCache; } catch { /* first run */ }
    if (existsSync(path)) {
      const st = statSync(path);
      const hit = cache[path];
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.sha256 === file.sha256 && st.size === file.sizeBytes) {
        return { state: 'ok', path };
      }
    }
    const status = await checkModelFile(this.opts.modelsDir, file);
    if (status.state === 'ok') {
      const st = statSync(path);
      cache[path] = { size: st.size, mtimeMs: st.mtimeMs, sha256: file.sha256 };
      mkdirSync(this.opts.stateDir, { recursive: true });
      writeFileSync(this.cachePath(), JSON.stringify(cache, null, 2));
    }
    return status;
  }

  /** Verify every approved model file (once per runtime; unchanged files are not re-hashed). */
  verify(): Promise<void> {
    this.verified ??= (async () => {
      for (const model of APPROVED_MODELS) {
        for (const file of [model.weights, model.projector]) {
          const status = await this.checkFile(file);
          this.files.set(modelFilePath(file), status);
          if (status.state !== 'ok') this.opts.log(`model file ${modelFilePath(file)}: ${status.state}`);
        }
      }
    })();
    return this.verified;
  }

  private usable(model: ApprovedModel): boolean {
    return this.files.get(modelFilePath(model.weights))?.state === 'ok' && this.files.get(modelFilePath(model.projector))?.state === 'ok';
  }

  async status(): Promise<RuntimeStatus> {
    const reason = this.unavailableReason();
    if (!reason) await this.verify();
    const models: ModelStatus[] = [];
    for (const model of APPROVED_MODELS) {
      const l = this.loaded.get(model.role);
      const s = this.stats.get(model.role) ?? { calls: 0, totalMs: 0 };
      models.push({
        role: model.role,
        id: model.id,
        name: model.name,
        license: model.license,
        quantization: model.quantization,
        revision: model.weights.revision,
        weights: this.files.get(modelFilePath(model.weights)) ?? null,
        projector: this.files.get(modelFilePath(model.projector)) ?? null,
        usable: this.usable(model),
        loaded: Boolean(l),
        ...(l ? { pid: l.child.pid, port: l.port, loadMs: l.loadMs } : {}),
        ...(l?.child.pid ? { memoryBytes: await processMemoryBytes(l.child.pid) } : {}),
        calls: s.calls,
        ...(s.calls > 0 ? { averageMs: Math.round(s.totalMs / s.calls) } : {}),
        ...(s.lastUsedAt ? { lastUsedAt: s.lastUsedAt } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
      });
    }
    const available = !reason && models.every((m) => m.usable);
    return {
      available,
      ...(reason ? { reason } : !available ? { reason: `model files not verified: ${models.filter((m) => !m.usable).map((m) => m.name).join(', ')}` } : {}),
      models,
    };
  }

  private async start(role: ModelRole): Promise<Loaded> {
    const model = approvedModel(role);
    const port = await freePort();
    const args = [
      '-m', join(this.opts.modelsDir, modelFilePath(model.weights)),
      '--mmproj', join(this.opts.modelsDir, modelFilePath(model.projector)),
      '--host', '127.0.0.1', '--port', String(port),
      '-c', String(this.opts.contextSize), '--jinja', '--no-webui', '-np', '1',
    ];
    const t0 = Date.now();
    const child = spawn(this.opts.llamaServer, args, { stdio: 'ignore', windowsHide: true });
    let exited: number | null = null;
    child.on('exit', (code) => {
      exited = code ?? -1;
      if (this.loaded.get(role)?.child === child) {
        this.loaded.delete(role);
        if (!this.closed) this.note(role, { lastError: `${model.name} stopped (exit ${code})` });
      }
    });
    while (Date.now() - t0 < this.opts.startTimeoutMs) {
      if (exited !== null) throw new Error(`${model.name} did not start (llama-server exit ${exited})`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
          const loaded = { child, port, loadMs: Date.now() - t0, lastUsed: Date.now() };
          this.loaded.set(role, loaded);
          this.opts.log(`${model.name} loaded in ${loaded.loadMs} ms on port ${port}`);
          return loaded;
        }
      } catch { /* still starting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    child.kill();
    throw new Error(`${model.name} did not become ready in ${this.opts.startTimeoutMs} ms`);
  }

  /** Stop a loaded model (its memory is freed). */
  async stop(role: ModelRole): Promise<void> {
    const l = this.loaded.get(role);
    if (!l) return;
    this.loaded.delete(role);
    await new Promise<void>((resolve) => {
      if (l.child.exitCode !== null) return resolve();
      l.child.once('exit', () => resolve());
      l.child.kill();
      setTimeout(resolve, 5000).unref();
    });
    this.opts.log(`${approvedModel(role).name} stopped`);
  }

  private async ensureLoaded(role: ModelRole): Promise<Loaded> {
    const current = this.loaded.get(role);
    if (current && current.child.exitCode === null) return current;
    await this.verify();
    const model = approvedModel(role);
    if (!this.usable(model)) throw new Error(`${model.name} model files are not verified; it cannot be loaded`);
    // Keep at most maxLoaded models in memory: stop the least recently used first.
    while (this.loaded.size >= this.opts.maxLoaded) {
      const [lru] = [...this.loaded.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]!;
      await this.stop(lru);
    }
    return this.start(role);
  }

  private note(role: ModelRole, patch: Partial<Stats> & { ms?: number }): void {
    const s = this.stats.get(role) ?? { calls: 0, totalMs: 0 };
    if (patch.ms !== undefined) { s.calls += 1; s.totalMs += patch.ms; }
    if (patch.lastUsedAt) s.lastUsedAt = patch.lastUsedAt;
    if (patch.lastError !== undefined) s.lastError = patch.lastError;
    this.stats.set(role, s);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.queue = this.queue.then(async () => {
        for (const role of [...this.loaded.keys()]) await this.stop(role);
      });
    }, this.opts.idleMs);
    this.idleTimer.unref();
  }

  /** Read a page with a model: loads it if needed, one call at a time. */
  read(role: ModelRole, request: ReadRequest): Promise<{ content: string; run: ModelRunRecord }> {
    const run = this.queue.then(() => this.readNow(role, request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readNow(role: ModelRole, request: ReadRequest): Promise<{ content: string; run: ModelRunRecord }> {
    if (this.closed) throw new Error('The model runtime is shut down.');
    const model = approvedModel(role);
    const startedAt = new Date().toISOString();
    const record = (ms: number, ok: boolean, error?: string): ModelRunRecord => ({
      runId: randomUUID(), role, modelId: model.id, modelName: model.name, quantization: model.quantization,
      revision: model.weights.revision, weightsSha256: model.weights.sha256, startedAt, ms, ok, ...(error ? { error } : {}),
    });
    const t0 = Date.now();
    try {
      const loaded = await this.ensureLoaded(role);
      const r = await fetch(`http://127.0.0.1:${loaded.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          temperature: 0,
          max_tokens: 2500,
          chat_template_kwargs: { enable_thinking: false },
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${request.imagePng}` } },
              { type: 'text', text: request.prompt },
            ],
          }],
          response_format: { type: 'json_schema', json_schema: { name: request.name, schema: request.jsonSchema } },
        }),
      });
      if (!r.ok) throw new Error(`${model.name} returned HTTP ${r.status}`);
      const body = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const ms = Date.now() - t0;
      loaded.lastUsed = Date.now();
      this.note(role, { ms, lastUsedAt: new Date().toISOString(), lastError: '' });
      this.armIdleTimer();
      return { content: body.choices?.[0]?.message?.content ?? '', run: record(ms, true) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.note(role, { lastError: message });
      throw Object.assign(new Error(message), { run: record(Date.now() - t0, false, message) });
    }
  }

  /**
   * Kill every model process at once (for process exit handlers, which cannot
   * wait): child processes outlive their parent on Windows.
   */
  killNow(): void {
    this.closed = true;
    for (const l of this.loaded.values()) if (l.child.exitCode === null) l.child.kill();
    this.loaded.clear();
  }

  /** Stop every model; no more calls are accepted. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const role of [...this.loaded.keys()]) await this.stop(role);
  }
}
