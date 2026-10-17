// One run-record format, written for every model call (oneShot's `record`): what it was, what it cost, how long it took.
// Projects keep their own files of records (Video Factory: out/<spec>/usage.json; lesson-videos: <name>.run.json and
// usage.json per film); these helpers write and sum them the same way in both.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeRunRecord(file, rec) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rec, null, 1) + '\n');
}

export function totals(records) {
  const t = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, seconds: 0, escalations: 0, cached: 0, failed: 0 };
  for (const r of records) {
    t.calls++;
    t.costUsd += r.costUsd;
    t.inputTokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    t.outputTokens += r.outputTokens;
    t.seconds += r.seconds ?? 0;
    if (r.escalated) t.escalations++;
    if (r.cached) t.cached++;
    if (!r.ok) t.failed++;
  }
  t.costUsd = +t.costUsd.toFixed(6);
  t.seconds = +t.seconds.toFixed(1);
  return t;
}

export function byStage(records) {
  const out = {};
  for (const r of records) (out[r.stage] ??= []).push(r);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, totals(v)]));
}

// A usage file of records (a film's, a video's): appended to, with its totals kept at the top for a quick read.
export function appendUsage(file, rec) {
  let entries = [];
  if (existsSync(file)) {
    try {
      entries = JSON.parse(readFileSync(file, 'utf8')).entries ?? [];
    } catch {
      entries = [];
    }
  }
  entries.push(rec);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ totals: totals(entries), byStage: byStage(entries), entries }, null, 1) + '\n');
}
