/** The lock directory every project shares (env `MURRAY_RENDER_LOCK` overrides). */
export declare const RENDER_LOCK: string;
/** The one log of turns for the Mac (env `MURRAY_RENDER_LOCK_LOG` overrides). */
export declare const LOCK_LOG: string;

export interface LockOptions {
  /** Names the project in the owner line and the log, e.g. "video-factory", "lesson-videos". */
  project: string;
  lock?: string;
  log?: string;
  /** Called once when the turn has to wait; without it a line goes to stderr at most once a minute. */
  onWait?: (msg: string) => void;
  /** Extra fields written into this turn's log line (e.g. script, args, checkout, shots). */
  extra?: Record<string, unknown>;
}

export interface LockTurn {
  at: string;
  project: string;
  what: string;
  id: string | null;
  pid: number;
  waitedMs: number;
  heldMs: number;
  /** Who held the lock while this turn waited. */
  waitedFor?: string;
  [extra: string]: unknown;
}

/** Waits its turn (first come, first served) without blocking the event loop, runs, then lets go and logs the turn. */
export declare function withRenderLock<T>(what: string, id: string | null, run: () => T | Promise<T>, opts: LockOptions): Promise<T>;
/** The same, waiting synchronously (for execFileSync callers). If `run` returns a promise the lock is held until it settles. */
export declare function withRenderLockSync<T>(what: string, id: string | null, run: () => T, opts: LockOptions): T;
/** Every logged turn, oldest first; `project` keeps one project's. */
export declare function lockTurns(opts?: { log?: string; project?: string }): LockTurn[];
