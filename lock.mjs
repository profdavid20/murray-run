// One Remotion render at a time on this Mac, across every project and checkout: two renders at once each open a Chrome
// and fight for the cores, so both run slower than one after the other. The lock is a directory made with mkdir (atomic)
// holding a `pid` file (and an `owner` line saying who); a lock whose owner is dead is taken over, and one younger than
// 5 s with no pid yet is just being made. Waiters queue first come, first served (a ticket file each in `<lock>.queue`),
// so a run that lets go between scenes can't take the lock straight back from one that has been waiting. Every turn is
// one line in one log for the Mac, with the project that took it, so each project's metrics can see the whole queue.
// A file protocol only: no Remotion, no project code.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RENDER_LOCK = process.env.MURRAY_RENDER_LOCK ?? join(homedir(), 'Library', 'Caches', 'remotion-render.lock');
export const LOCK_LOG = process.env.MURRAY_RENDER_LOCK_LOG ?? join(homedir(), 'Library', 'Logs', 'murray-run', 'render-lock.jsonl');

const JUST_MADE_MS = 5000;
// Stills take under a second each, so a slow poll would leave the machine idle between turns.
const POLL_MS = 100;
// Said once a run (or again after a quiet minute), not before every still.
const TELL_EVERY_MS = 60_000;
let told = 0;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const read = (f) => {
  try {
    return readFileSync(f, 'utf8').trim();
  } catch {
    return '';
  }
};

// The lock's owner, or null when nobody holds it (or the holder died, and the lock was cleared).
function holder(lock) {
  const pid = Number(read(join(lock, 'pid')));
  if (!pid) {
    let age;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      return null;
    }
    if (age < JUST_MADE_MS) return 'a render starting';
    rmSync(lock, { recursive: true, force: true });
    return null;
  }
  if (!alive(pid)) {
    rmSync(lock, { recursive: true, force: true });
    return null;
  }
  return read(join(lock, 'owner')) || `pid ${pid}`;
}

// It's this process's turn when no live waiter queued before it. A ticket whose process died is cleared.
function myTurn(queue, ticket) {
  let tickets;
  try {
    tickets = readdirSync(queue).sort();
  } catch {
    return true;
  }
  for (const t of tickets) {
    const f = join(queue, t);
    if (f === ticket) return true;
    if (alive(Number(t.split('-')[1]))) return false;
    rmSync(f, { force: true });
  }
  return true;
}

// One step of waiting: true once the lock is this process's. Shared by the async and the blocking waits.
function attempt(w) {
  if (myTurn(w.queue, w.ticket)) {
    try {
      mkdirSync(w.lock);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (holder(w.lock) === null) return attempt(w);
  }
  if (!w.ticket) {
    mkdirSync(w.queue, { recursive: true });
    w.ticket = join(w.queue, `${String(w.asked).padStart(15, '0')}-${process.pid}`);
    writeFileSync(w.ticket, '');
  }
  if (w.waitedFor === undefined) {
    w.waitedFor = holder(w.lock) ?? 'a render ahead in the queue';
    const msg = `  waiting for another render to finish (${w.waitedFor})…`;
    if (w.opts.onWait) w.opts.onWait(msg);
    else if (Date.now() - told > TELL_EVERY_MS) {
      told = Date.now();
      console.error(`${msg} (turns logged in ${w.log})`);
    }
  }
  return false;
}

// Held by this process: a render inside a render shares the one turn.
let depth = 0;
const exitHooked = new Set();

function start(what, id, opts) {
  if (!opts || !opts.project) throw new Error('@murray/run/lock: opts.project is required (it names the project in the shared log)');
  const lock = opts.lock ?? RENDER_LOCK;
  mkdirSync(join(lock, '..'), { recursive: true });
  return { what, id, opts, lock, log: opts.log ?? LOCK_LOG, queue: `${lock}.queue`, asked: Date.now(), ticket: null, waitedFor: undefined, got: 0 };
}

function take(w) {
  if (w.ticket) rmSync(w.ticket, { force: true });
  depth = 1;
  writeFileSync(join(w.lock, 'owner'), [w.opts.project, w.what, w.id, `(pid ${process.pid})`].filter(Boolean).join(' '));
  writeFileSync(join(w.lock, 'pid'), String(process.pid));
  if (!exitHooked.has(w.lock)) {
    exitHooked.add(w.lock);
    process.on('exit', () => {
      if (depth > 0 && read(join(w.lock, 'pid')) === String(process.pid)) rmSync(w.lock, { recursive: true, force: true });
    });
  }
  w.got = Date.now();
}

function release(w) {
  depth = 0;
  if (read(join(w.lock, 'pid')) === String(process.pid)) rmSync(w.lock, { recursive: true, force: true });
  const turn = {
    at: new Date(w.asked).toISOString(),
    project: w.opts.project,
    what: w.what,
    id: w.id,
    pid: process.pid,
    waitedMs: w.got - w.asked,
    heldMs: Date.now() - w.got,
    ...(w.waitedFor ? { waitedFor: w.waitedFor } : {}),
    ...(w.opts.extra ?? {}),
  };
  try {
    mkdirSync(join(w.log, '..'), { recursive: true });
    appendFileSync(w.log, `${JSON.stringify(turn)}\n`);
  } catch {
    // The log is for measuring; a render never fails over it.
  }
}

function drop(w) {
  if (w.ticket) rmSync(w.ticket, { force: true });
}

export async function withRenderLock(what, id, run, opts) {
  if (depth > 0) {
    depth++;
    try {
      return await run();
    } finally {
      depth--;
    }
  }
  const w = start(what, id, opts);
  try {
    while (!attempt(w)) await new Promise((r) => setTimeout(r, POLL_MS));
  } catch (e) {
    drop(w);
    throw e;
  }
  take(w);
  try {
    return await run();
  } finally {
    release(w);
  }
}

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// For scripts that run Remotion with execFileSync: waits without returning to the event loop. When `run` returns a
// promise, the lock is held until it settles.
export function withRenderLockSync(what, id, run, opts) {
  if (depth > 0) {
    depth++;
    let result;
    try {
      result = run();
    } catch (e) {
      depth--;
      throw e;
    }
    if (result instanceof Promise) return result.finally(() => depth--);
    depth--;
    return result;
  }
  const w = start(what, id, opts);
  try {
    while (!attempt(w)) nap(POLL_MS);
  } catch (e) {
    drop(w);
    throw e;
  }
  take(w);
  let result;
  try {
    result = run();
  } catch (e) {
    release(w);
    throw e;
  }
  if (result instanceof Promise) return result.finally(() => release(w));
  release(w);
  return result;
}

// Every logged turn, oldest first; `project` narrows to one project's. A line that isn't JSON is skipped.
export function lockTurns({ log = LOCK_LOG, project } = {}) {
  const turns = [];
  for (const line of read(log).split('\n')) {
    if (!line) continue;
    try {
      turns.push(JSON.parse(line));
    } catch {
      // a half-written line from a killed process
    }
  }
  return project ? turns.filter((t) => t.project === project) : turns;
}
