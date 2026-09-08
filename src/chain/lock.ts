/**
 * Advisory file lock for the audit chain.
 *
 * Appending a record needs the previous record's hash, so an append is a read-then-write and
 * two processes doing it at once would fork the chain. The lock is a sidecar file created with
 * O_EXCL (`wx`): creation is atomic on NTFS, ext4, APFS and tmpfs, so exactly one process wins.
 * The loser polls. A lock older than `staleMs` is treated as abandoned (a crashed writer) and
 * removed. The write itself is a single `appendFileSync` of one line with O_APPEND, so even a
 * writer that ignores the lock cannot interleave bytes inside another writer's line.
 *
 * This is process-level coordination on one host. A shared chain across hosts needs a real
 * log service; see the decision record.
 */

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
  /** Give up after this long. Default 5000 ms. */
  timeoutMs?: number;
  /** A lock file older than this is abandoned and removed. Default 30000 ms. */
  staleMs?: number;
  /** Poll interval while waiting. Default 10 ms. */
  pollMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`could not acquire ${lockPath} within ${timeoutMs}ms`);
    this.name = "LockTimeoutError";
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep without spinning. The hook is a short-lived process; blocking is fine. */
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Run `fn` while holding the lock at `lockPath`. Always releases, even when `fn` throws. */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30000;
  const pollMs = opts.pollMs ?? 10;
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // another waiter removed it first; loop and retry
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
      sleepSync(pollMs);
    }
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone (stale sweep by a waiter); nothing to release
    }
  }
}
