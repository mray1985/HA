/**
 * The local AI's running work holds a vault lock back until it has saved.
 */

import { describe, expect, it, vi } from 'vitest';
import { backgroundWorkRunning, runBackgroundWork, whenBackgroundWorkIdle } from '../services/backgroundWork';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('background work', () => {
  it('runs a waiting lock at once when nothing is running', () => {
    const then = vi.fn();
    whenBackgroundWorkIdle(then);
    expect(then).toHaveBeenCalledOnce();
    expect(backgroundWorkRunning()).toBe(false);
  });

  it('holds the lock until every running job has ended', async () => {
    const first = deferred();
    const second = deferred();
    const a = runBackgroundWork(() => first.promise);
    const b = runBackgroundWork(() => second.promise);
    const then = vi.fn();
    whenBackgroundWorkIdle(then);
    expect(backgroundWorkRunning()).toBe(true);
    first.resolve();
    await a;
    expect(then).not.toHaveBeenCalled();
    second.resolve();
    await b;
    expect(then).toHaveBeenCalledOnce();
    expect(backgroundWorkRunning()).toBe(false);
  });

  it('releases the lock when a job fails, and a cancelled lock never runs', async () => {
    const job = deferred();
    const run = runBackgroundWork(() => job.promise);
    const kept = vi.fn();
    const cancelled = vi.fn();
    whenBackgroundWorkIdle(kept);
    const cancel = whenBackgroundWorkIdle(cancelled);
    cancel();
    job.reject(new Error('the model stopped'));
    await expect(run).rejects.toThrow('the model stopped');
    expect(kept).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });
});
