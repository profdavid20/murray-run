import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lockTurns, withRenderLock, withRenderLockSync } from './lock.mjs';

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'murray-lock-'));
  return { lock: join(d, 'remotion-render.lock'), log: join(d, 'render-lock.jsonl'), project: 'test' };
};

const until = async (ok) => {
  while (!ok()) await new Promise((r) => setTimeout(r, 20));
};
const pidWritten = (lock) => () => {
  try {
    return Number(readFileSync(join(lock, 'pid'), 'utf8')) > 0;
  } catch {
    return false;
  }
};

// Another process holds the lock for `ms`, the way lesson-videos' old scripts/bundle.ts did: mkdir, then only a pid file.
const holdFor = (lock, ms) =>
  spawn(process.execPath, ['-e', `const fs=require('fs');fs.mkdirSync(${JSON.stringify(lock)});fs.writeFileSync(${JSON.stringify(join(lock, 'pid'))},String(process.pid));setTimeout(()=>fs.rmSync(${JSON.stringify(lock)},{recursive:true,force:true}),${ms})`]);

test('two renders in one process take turns, and each turn is logged with its project', async () => {
  const o = fresh();
  const order = [];
  await withRenderLock('still', 'a', async () => order.push('a'), o);
  await withRenderLock('still', 'b', async () => order.push('b'), o);
  assert.deepEqual(order, ['a', 'b']);
  const turns = lockTurns({ log: o.log });
  assert.deepEqual(turns.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(turns.map((t) => t.project), ['test', 'test']);
});

test('a render inside a render shares the turn instead of waiting for itself', async () => {
  const o = fresh();
  const got = await withRenderLock('scene', 'outer', () => withRenderLock('still', 'inner', async () => 7, o), o);
  assert.equal(got, 7);
  assert.equal(withRenderLockSync('render', 'outer', () => withRenderLockSync('still', 'inner', () => 8, o), o), 8);
  assert.deepEqual(lockTurns({ log: o.log }).map((t) => t.id), ['outer', 'outer']);
});

test('a lock left by a dead render is taken over at once', async () => {
  const o = fresh();
  mkdirSync(o.lock);
  writeFileSync(join(o.lock, 'pid'), '999999');
  const t0 = Date.now();
  await withRenderLock('still', 'x', async () => {}, { ...o, onWait: () => assert.fail('waited for a dead pid') });
  assert.ok(Date.now() - t0 < 500);
});

test('a render waits while another process holds the lock, and logs who it waited for', async () => {
  const o = fresh();
  const holder = holdFor(o.lock, 1500);
  await until(pidWritten(o.lock));
  const waits = [];
  await withRenderLock('scene', 'waiter', async () => {}, { ...o, onWait: (m) => waits.push(m) });
  holder.kill();
  const [turn] = lockTurns({ log: o.log });
  assert.equal(waits.length, 1);
  assert.match(waits[0], /pid \d+/);
  assert.ok(turn.waitedMs >= 1000, `waited ${turn.waitedMs} ms`);
  assert.match(turn.waitedFor ?? '', /pid/);
});

test('the blocking wait waits too, and holds the lock until a returned promise settles', async () => {
  const o = fresh();
  const holder = holdFor(o.lock, 800);
  await until(pidWritten(o.lock));
  let ran = false;
  const p = withRenderLockSync('stills', 'L19', () => new Promise((r) => setTimeout(() => r((ran = true)), 300)), { ...o, onWait: () => {}, extra: { shots: 4 } });
  assert.ok(pidWritten(o.lock)(), 'the lock is held while the promise runs');
  await p;
  holder.kill();
  assert.ok(ran);
  const [turn] = lockTurns({ log: o.log });
  assert.ok(turn.waitedMs >= 500, `waited ${turn.waitedMs} ms`);
  assert.ok(turn.heldMs >= 250, `held ${turn.heldMs} ms`);
  assert.equal(turn.shots, 4);
});

test('a failing run lets go of the lock and is still logged', async () => {
  const o = fresh();
  await assert.rejects(withRenderLock('still', 'bad', async () => {
    throw new Error('boom');
  }, o));
  assert.throws(() => withRenderLockSync('still', 'bad-sync', () => {
    throw new Error('boom');
  }, o));
  await withRenderLock('still', 'next', async () => {}, { ...o, onWait: () => assert.fail('the lock was left behind') });
  assert.deepEqual(lockTurns({ log: o.log }).map((t) => t.id), ['bad', 'bad-sync', 'next']);
});

test('waiters go in the order they came: a free lock still waits for a render queued before it', async () => {
  const o = fresh();
  const queue = `${o.lock}.queue`;
  // Another process holds the lock for 0.4 s and is queued (earlier) for its next turn until 1.4 s.
  const ticket = join(queue, `${'1'.padStart(15, '0')}-PID`);
  const holder = spawn(process.execPath, ['-e', `const fs=require('fs');const t=${JSON.stringify(ticket)}.replace('PID',process.pid);fs.mkdirSync(${JSON.stringify(o.lock)});fs.writeFileSync(${JSON.stringify(join(o.lock, 'pid'))},String(process.pid));fs.mkdirSync(${JSON.stringify(queue)},{recursive:true});fs.writeFileSync(t,'');setTimeout(()=>fs.rmSync(${JSON.stringify(o.lock)},{recursive:true,force:true}),400);setTimeout(()=>fs.rmSync(t),1400)`]);
  await until(pidWritten(o.lock));
  withRenderLockSync('still', 'later', () => {}, { ...o, onWait: () => {} });
  holder.kill();
  const [turn] = lockTurns({ log: o.log });
  assert.ok(turn.waitedMs >= 1300, `waited only ${turn.waitedMs} ms`);
});

test('lockTurns keeps one project and skips a half-written line', () => {
  const o = fresh();
  appendFileSync(o.log, '{"project":"video-factory","id":"a"}\n{"proj\n{"project":"lesson-videos","id":"b"}\n');
  assert.deepEqual(lockTurns({ log: o.log, project: 'lesson-videos' }).map((t) => t.id), ['b']);
  assert.equal(lockTurns({ log: o.log }).length, 2);
});

test('the project is required, so the shared log always says whose turn it was', async () => {
  await assert.rejects(withRenderLock('still', 'x', async () => {}, {}), /project/);
});
