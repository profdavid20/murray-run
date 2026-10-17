import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractJson, oneShot, pool, StageError } from './call.mjs';
import { priceOf, route } from './models.mjs';
import { appendUsage, totals } from './usage.mjs';

const MODELS = {
  tiers: {
    top: { model: 'big', effort: 'high', escalateTo: 'bigger' },
    small: { model: 'tiny', effort: null, escalateTo: 'big' },
  },
  stages: { title: { tier: 'small' }, judge: { tier: 'top' } },
  escalation: { afterFailures: 2 },
  prices: { unit: 'USD per million', tiny: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
};

// A fake `claude`: logs its argv and stdin, then replies with the next line of a script file.
function fakeCli(replies) {
  const d = mkdtempSync(join(tmpdir(), 'murray-call-'));
  writeFileSync(join(d, 'replies.json'), JSON.stringify(replies));
  writeFileSync(join(d, 'n'), '0');
  const bin = join(d, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs'); const d = ${JSON.stringify(d)};
let input = ''; process.stdin.on('data', (c) => (input += c)); process.stdin.on('end', () => {
  const n = Number(fs.readFileSync(d + '/n', 'utf8')); fs.writeFileSync(d + '/n', String(n + 1));
  fs.appendFileSync(d + '/calls.jsonl', JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');
  const r = JSON.parse(fs.readFileSync(d + '/replies.json', 'utf8'))[n];
  if (r.exit) { process.stderr.write('boom'); process.exit(r.exit); }
  process.stdout.write(JSON.stringify({ result: r.text ?? '', structured_output: r.structured, session_id: 's' + n, total_cost_usd: r.cost ?? 0.001,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } }));
});
`,
  );
  chmodSync(bin, 0o755);
  const calls = () => readFileSync(join(d, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { bin, d, calls };
}

const titleCheck = (raw) =>
  raw && typeof raw.title === 'string' && raw.title.split(' ').length === 3 ? { ok: true, value: raw } : { ok: false, problems: ['title: must be three words'] };

test('route: attempts on the tier model, then one escalation at effort high', () => {
  const r = route(MODELS, 'title');
  assert.deepEqual(r.attempts, [
    { model: 'tiny', effort: null, escalated: false },
    { model: 'tiny', effort: null, escalated: false },
    { model: 'big', effort: 'high', escalated: true },
  ]);
  assert.equal(route(MODELS, 'title', { model: 'x' }).model, 'x');
  assert.throws(() => route(MODELS, 'nope'), /Unknown stage "nope"/);
});

test('priceOf: per-million prices, 0 for an unpriced model', () => {
  assert.equal(priceOf(MODELS, 'tiny', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }), 6);
  assert.equal(priceOf(MODELS, 'big', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
});

test('a valid first reply: lean flags, prompt on stdin, thinking off without effort, one record', async () => {
  const cli = fakeCli([{ text: 'Here: {"title":"Plants Make Food"}' }]);
  const recs = [];
  const v = await oneShot({ stage: 'title', models: MODELS, system: 'S', prompt: 'P', check: titleCheck, cli: cli.bin, backend: 'claude-cli', record: (r) => recs.push(r), id: 'vid-1' });
  assert.deepEqual(v, { title: 'Plants Make Food' });
  const [c] = cli.calls();
  assert.equal(c.input, 'P');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt']) assert.ok(c.argv.includes(f), f);
  assert.ok(!c.argv.includes('--effort'));
  assert.match(c.argv[c.argv.indexOf('--settings') + 1], /"alwaysThinkingEnabled":false/);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].ok, true);
  assert.equal(recs[0].id, 'vid-1');
  assert.equal(recs[0].session, 's0');
  assert.equal(recs[0].costUsd, 0.001);
  assert.equal(typeof recs[0].seconds, 'number');
});

test('a retry is shown its rejected draft; after two failures it escalates; structured output wins', async () => {
  const cli = fakeCli([{ text: '{"title":"Plants"}' }, { exit: 1 }, { text: 'ignored', structured: { title: 'Plants Make Food' } }]);
  const recs = [];
  const v = await oneShot({ stage: 'title', models: MODELS, system: 'S', prompt: 'P', check: titleCheck, cli: cli.bin, backend: 'claude-cli', record: (r) => recs.push(r), jsonSchema: { type: 'object' } });
  assert.deepEqual(v, { title: 'Plants Make Food' });
  const calls = cli.calls();
  assert.match(calls[1].input, /Your previous reply:\n\{"title":"Plants"\}[\s\S]*It was rejected:\n- title: must be three words/);
  assert.equal(calls[2].argv[calls[2].argv.indexOf('--model') + 1], 'big');
  assert.equal(calls[2].argv[calls[2].argv.indexOf('--effort') + 1], 'high');
  assert.ok(calls[2].argv.includes('--json-schema'));
  assert.deepEqual(recs.map((r) => [r.attempt, r.ok, r.escalated]), [[1, false, false], [2, false, false], [3, true, true]]);
});

test('every attempt rejected: StageError', async () => {
  const cli = fakeCli([{ text: 'no' }, { text: 'no' }, { text: 'no' }]);
  await assert.rejects(oneShot({ stage: 'title', models: MODELS, system: 'S', prompt: 'P', check: titleCheck, cli: cli.bin, backend: 'claude-cli' }), StageError);
});

test('stage cache: the same prompt is answered from the cache, re-checked, at no cost', async () => {
  const cli = fakeCli([{ text: '{"title":"Plants Make Food"}' }]);
  const dir = mkdtempSync(join(tmpdir(), 'murray-cache-'));
  const recs = [];
  const o = { stage: 'title', models: MODELS, system: 'S', prompt: 'P', check: titleCheck, cli: cli.bin, backend: 'claude-cli', cache: { dir }, record: (r) => recs.push(r) };
  await oneShot(o);
  const again = await oneShot(o);
  assert.deepEqual(again, { title: 'Plants Make Food' });
  assert.equal(cli.calls().length, 1);
  assert.equal(recs[1].cached, true);
  assert.equal(recs[1].costUsd, 0);
});

test('tools, kept sessions and the raw session file', async () => {
  const cli = fakeCli([{ structured: { title: 'Plants Make Food' } }]);
  const sessionFile = join(cli.d, 'out', 'w.session.json');
  await oneShot({ stage: 'judge', models: MODELS, system: 'S', prompt: 'P', check: titleCheck, cli: cli.bin, backend: 'claude-cli', tools: ['Read'], keepSession: true, sessionFile });
  const [c] = cli.calls();
  assert.equal(c.argv[c.argv.indexOf('--tools') + 1], 'Read');
  assert.equal(c.argv[c.argv.indexOf('--allowedTools') + 1], 'Read');
  assert.ok(!c.argv.includes('--no-session-persistence'));
  assert.equal(c.argv[c.argv.indexOf('--effort') + 1], 'high');
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).session_id, 's0');
});

test('calls overlap: two slow calls take about one call\'s time', async () => {
  const d = mkdtempSync(join(tmpdir(), 'murray-slow-'));
  const bin = join(d, 'claude');
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nsleep 1\necho '{"result":"{\\"title\\":\\"Plants Make Food\\"}","usage":{}}'\n`);
  chmodSync(bin, 0o755);
  const o = { stage: 'title', models: MODELS, system: 'S', prompt: 'P', check: titleCheck, cli: bin, backend: 'claude-cli' };
  const t = Date.now();
  await Promise.all([oneShot(o), oneShot(o)]);
  assert.ok(Date.now() - t < 1900, `took ${Date.now() - t} ms`);
});

test('pool keeps order and the limit', async () => {
  let live = 0;
  let most = 0;
  const out = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    most = Math.max(most, ++live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(most, 2);
});

test('extractJson finds fenced or bare JSON', () => {
  assert.deepEqual(extractJson('x ```json\n{"a":1}\n``` y'), { a: 1 });
  assert.deepEqual(extractJson('sure: [1,2]'), [1, 2]);
  assert.throws(() => extractJson('nothing'), /No JSON/);
});

test('usage totals and appendUsage', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'murray-usage-')), 'usage.json');
  const r = { stage: 'a', model: 'm', backend: 'claude-cli', inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.5, escalated: false, attempt: 1, ok: true, seconds: 3, at: 'now' };
  appendUsage(f, r);
  appendUsage(f, { ...r, ok: false, escalated: true });
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(j.entries.length, 2);
  assert.deepEqual(j.totals, totals(j.entries));
  assert.equal(j.totals.inputTokens, 32);
  assert.equal(j.totals.failed, 1);
  assert.equal(j.byStage.a.calls, 2);
});
