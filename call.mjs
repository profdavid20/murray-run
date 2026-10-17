// The one model call both projects make. A stage names its tier in the project's config/models.json; the call runs
// headless Claude Code (David's subscription) or the API, checks the reply, retries by fixing its own rejected draft,
// escalates to the next model, can answer from a stage cache, and writes a run record for every attempt.
//
// Lifted from Video Factory's runStage (thinking off unless the tier sets an effort, hooks off, no session file, retry
// with the draft, escalation, stage cache, API backend) with lesson-videos' oneShot (async spawn, pool, --json-schema).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadModels, priceOf, route } from './models.mjs';

export class StageError extends Error {}

// Web search is $10 per 1,000 searches on top of tokens (platform.claude.com web search tool docs, checked 2026-10-17).
const WEB_SEARCH_USD = 0.01;

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('No JSON in the reply');
  return JSON.parse(body.slice(start, end + 1));
}

export function backendFromEnv(env = process.env) {
  const v = env.MURRAY_AI_BACKEND;
  if (v === 'api' || v === 'claude-cli') return v;
  return env.ANTHROPIC_API_KEY ? 'api' : 'claude-cli';
}

// At most `n` at once (films of a lesson written side by side); results in the order of `items`.
export async function pool(items, n, f) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i], i);
      }
    }),
  );
  return out;
}

async function callApi(model, effort, c) {
  let Anthropic;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new Error('The API backend needs @anthropic-ai/sdk installed in the project');
  }
  const client = new Anthropic();
  const content = [];
  for (const img of c.images ?? []) {
    const media = img.endsWith('.png') ? 'image/png' : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type: media, data: readFileSync(img).toString('base64') } });
  }
  content.push({ type: 'text', text: c.prompt });
  const params = {
    model,
    max_tokens: c.maxTokens ?? 16000,
    system: [{ type: 'text', text: c.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  };
  if (effort) params.output_config = { effort };
  // Server tools: Anthropic runs the searches and fetches. web_fetch only opens URLs already in the conversation
  // (the search results), so it can't be steered to an address the model made up.
  if (c.web)
    params.tools = [
      { type: 'web_search_20250305', name: 'web_search', max_uses: c.web.maxSearches },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: c.web.maxFetches, max_content_tokens: 20000 },
    ];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let searches = 0;
  let msg;
  // A long tool turn stops with pause_turn; sending its content back unchanged lets the server carry on.
  for (let turn = 0; ; turn++) {
    msg = await client.messages.stream(params).finalMessage();
    const u = msg.usage;
    usage.input += u.input_tokens;
    usage.output += u.output_tokens;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    searches += u.server_tool_use?.web_search_requests ?? 0;
    if (msg.stop_reason !== 'pause_turn' || turn >= 5) break;
    params.messages = [...params.messages, { role: 'assistant', content: msg.content }];
  }
  if (msg.stop_reason === 'refusal') throw new Error(`Model declined (${model})`);
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return { text, usage, extraUsd: searches * WEB_SEARCH_USD, costUsd: null };
}

// Headless Claude Code: works on a Mac signed in to Claude, with no API key. Async, so calls overlap.
async function callCli(model, effort, c) {
  const prompt = c.images?.length ? `${c.prompt}\n\nLook at these image files (use the Read tool on each):\n${c.images.map((i) => `- ${i}`).join('\n')}` : c.prompt;
  // No effort level means no thinking, as on the API: a headless Haiku left to its defaults spent up to 6,000 hidden
  // tokens (46 s) on two captions, against 285 (7 s) with thinking off. Memory, hooks and slash commands stay out too.
  const settings = { alwaysThinkingEnabled: effort !== null, autoMemoryEnabled: false, disableAllHooks: true };
  const tools = [...new Set([...(c.images?.length ? ['Read'] : []), ...(c.web ? ['WebSearch', 'WebFetch'] : []), ...(c.tools ?? [])])].join(',');
  const args = ['-p', '--model', model, '--output-format', 'json', '--system-prompt', c.system, '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--settings', JSON.stringify(settings), '--tools', tools];
  if (!c.keepSession) args.push('--no-session-persistence');
  if (effort) args.push('--effort', effort);
  if (tools) args.push('--allowedTools', tools);
  if (c.jsonSchema) args.push('--json-schema', JSON.stringify(c.jsonSchema));
  const { code, stdout, stderr } = await new Promise((res, rej) => {
    const p = spawn(c.cli ?? process.env.MURRAY_RUN_CLAUDE ?? 'claude', args, { cwd: c.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => p.kill('SIGTERM'), c.timeoutMs ?? 20 * 60_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
  if (c.sessionFile) {
    mkdirSync(dirname(c.sessionFile), { recursive: true });
    writeFileSync(c.sessionFile, stdout);
  }
  if (code !== 0) throw new Error(`claude CLI failed (exit ${code}): ${(stderr || stdout).slice(-600)}`);
  const j = JSON.parse(stdout);
  if (j.is_error) throw new Error(`claude CLI error: ${j.result}`);
  const u = j.usage ?? {};
  return {
    // After a web search the CLI appends a "Sources:" list of markdown links, whose brackets would break extractJson.
    text: c.web ? (j.result ?? '').replace(/\n+\**Sources:?\**\s*\n(?:\s*[-*].*(?:\n|$))+\s*$/, '') : (j.result ?? ''),
    structured: j.structured_output,
    usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    costUsd: j.total_cost_usd ?? null,
    session: j.session_id,
  };
}

const cacheKey = (model, o) => createHash('sha256').update(JSON.stringify([model, o.system, o.prompt, o.maxTokens ?? null])).digest('hex').slice(0, 24);

export async function oneShot(o) {
  const cfg = typeof o.models === 'string' ? loadModels(o.models) : o.models;
  const r = route(cfg, o.stage, { model: o.model });
  const be = o.backend ?? backendFromEnv();
  const record = (rec) => o.record?.({ ...(o.id ? { id: o.id } : {}), ...rec, at: new Date().toISOString() });
  const zero = { backend: be, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  // Only replies that depend on the prompt alone are cached: never pictures (files change) or the web (pages change).
  const cacheFile = o.cache && !o.images?.length && !o.web ? join(o.cache.dir, o.stage, `${cacheKey(r.model, o)}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const c = o.check(JSON.parse(readFileSync(cacheFile, 'utf8')));
      if (c.ok) {
        record({ stage: o.stage, model: r.model, ...zero, escalated: false, attempt: 0, ok: true, cached: true, seconds: 0 });
        return c.value;
      }
    } catch {
      // An unreadable cache entry is just a miss.
    }
  }
  let lastProblems = [];
  let lastReply = '';
  for (let i = 0; i < r.attempts.length; i++) {
    const { model, effort, escalated } = r.attempts[i];
    // A retry fixes the rejected draft rather than writing a new one, so what was right survives.
    const prompt = lastProblems.length
      ? `${o.prompt}\n\n${lastReply ? `Your previous reply:\n${lastReply}\n\n` : ''}It was rejected:\n- ${lastProblems.join('\n- ')}\n${lastReply ? 'Reply with the corrected version: change only what these problems need, keep everything else.' : 'Reply again, fixing these.'}`
      : o.prompt;
    const started = Date.now();
    const seconds = () => +((Date.now() - started) / 1000).toFixed(1);
    let res;
    try {
      res = be === 'api' ? await callApi(model, effort, { ...o, prompt }) : await callCli(model, effort, { ...o, prompt });
    } catch (e) {
      lastProblems = [e.message];
      record({ stage: o.stage, model, ...zero, escalated, attempt: i + 1, ok: false, problems: lastProblems, seconds: seconds() });
      continue;
    }
    const cost = res.costUsd ?? priceOf(cfg, model, res.usage) + (res.extraUsd ?? 0);
    const raw = res.structured !== undefined && res.structured !== null ? JSON.stringify(res.structured) : res.text;
    lastReply = raw.length <= 60000 ? raw : '';
    let ok = false;
    let value;
    try {
      const c = o.check(res.structured ?? extractJson(res.text));
      if (c.ok) {
        ok = true;
        value = c.value;
      } else lastProblems = c.problems;
    } catch (e) {
      lastProblems = [e.message];
    }
    record({
      stage: o.stage,
      model,
      backend: be,
      inputTokens: res.usage.input,
      outputTokens: res.usage.output,
      cacheReadTokens: res.usage.cacheRead,
      cacheWriteTokens: res.usage.cacheWrite,
      costUsd: +cost.toFixed(6),
      escalated,
      attempt: i + 1,
      ok,
      ...(ok ? {} : { problems: lastProblems.slice(0, 8) }),
      seconds: seconds(),
      ...(res.session ? { session: res.session } : {}),
    });
    if (ok) {
      if (cacheFile) {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(value));
      }
      return value;
    }
  }
  throw new StageError(`Stage ${o.stage} failed after escalation: ${lastProblems.join('; ')}`);
}
