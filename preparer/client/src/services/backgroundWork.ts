/**
 * Work the local AI is doing for the preparer — documents being read and
 * placed, a client's reply being read — which saves its results when it ends.
 *
 * The vault's idle and hidden-window locks wait for it (PreparerApp): the
 * screen locks at once, but the key and the decrypted cases are kept until
 * the work has saved, so a preparer who drops a pile of documents and walks
 * away never loses them to the lock.
 */

let running = 0;
const idleListeners = new Set<() => void>();

/** Run `job` as background work: locks wait for it to end. */
export async function runBackgroundWork<T>(job: () => Promise<T>): Promise<T> {
  running++;
  try {
    return await job();
  } finally {
    running--;
    if (running === 0) {
      for (const listener of [...idleListeners]) {
        idleListeners.delete(listener);
        listener();
      }
    }
  }
}

export function backgroundWorkRunning(): boolean {
  return running > 0;
}

/** Call `then` once no work is running — now, when none is. Returns a function that cancels it. */
export function whenBackgroundWorkIdle(then: () => void): () => void {
  if (running === 0) {
    then();
    return () => {};
  }
  idleListeners.add(then);
  return () => {
    idleListeners.delete(then);
  };
}
