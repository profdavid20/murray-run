# @murray/run — the shared running layer

The code that *runs* the work for Video Factory (`~/Projects/video-factory`) and lesson-videos (`~/Projects/lesson-videos`),
written once so a saving made in one project reaches both. The drawing engines stay in their projects: this package never
imports Remotion or either project's code. Plan: `video-factory/docs/SHARED-RUN-LAYER-PROPOSAL.md`.

**Public, code only.** No prompts, briefs, specs, student work, keys or prices that aren't public belong here.

## Install

Pin a tag with the HTTPS tarball, as a normal dependency:

```bash
npm install https://github.com/profdavid20/murray-run/archive/refs/tags/v0.2.0.tar.gz
```

Never the `github:profdavid20/murray-run#v0.1.0` shorthand: npm turns it into `git+ssh://`, which fails without SSH keys.
The package ships plain `.mjs` + `.d.ts`, so nothing has to transpile `node_modules`.

**Bumping:** Video Factory bumps as soon as a tag lands. lesson-videos bumps automatically at the weekend, between lessons,
once its typecheck, tests and one film's `make --review` pass on the new tag, and records it in its `metrics/ledger.md`.

## Modules

### `@murray/run/lock` (v0.1.0)

One Remotion render at a time on this Mac, across every project and checkout.

- Lock: `~/Library/Caches/remotion-render.lock` (a directory made with mkdir, holding `pid` and `owner`). A dead owner's lock
  is taken over; one under 5 s old with no pid yet is still being made.
- Queue: first come, first served (`<lock>.queue/<asked-ms>-<pid>`); a dead waiter's ticket is cleared. 100 ms poll.
- Log: one file for the Mac, `~/Library/Logs/murray-run/render-lock.jsonl`, a line per turn:
  `{at, project, what, id, pid, waitedMs, heldMs, waitedFor?, ...extra}`.
- A render inside a render (same process) shares the turn.

```ts
import { withRenderLock, withRenderLockSync, lockTurns } from '@murray/run/lock';

await withRenderLock('still', 'scene-3', () => renderStill(...), { project: 'video-factory' });
withRenderLockSync('render', 'L19-sci-1', () => execFileSync('npx', ['remotion', 'render', ...]), {
  project: 'lesson-videos',
  extra: { script: 'make.ts', checkout: ROOT },
});
lockTurns({ project: 'lesson-videos' }); // every logged turn, oldest first
```

`MURRAY_RENDER_LOCK` and `MURRAY_RENDER_LOCK_LOG` move the lock and the log (tests, a server).

### `@murray/run/call` (v0.2.0)

The one model call. A stage names its tier in **the project's own** `config/models.json` (model ids, efforts, escalation and
prices stay in each project); the call runs headless Claude Code (lean: thinking off unless the tier sets an effort, no MCP,
no hooks, no memory, no slash commands, no session file) or the API when `ANTHROPIC_API_KEY` is set, checks the reply,
retries by showing the model its own rejected draft, escalates after `escalation.afterFailures` failures, and can answer from
a stage cache. Async, so calls overlap; `pool(items, n, f)` caps how many at once. `jsonSchema` passes `--json-schema`, so the
CLI hands back structured output instead of JSON hunted out of prose.

```ts
import { oneShot, pool, StageError } from '@murray/run/call';

const scenes = await oneShot({
  stage: 'script-write',              // in config/models.json `stages`
  models: join(ROOT, 'config/models.json'),
  system, prompt,
  check: (raw) => { const p = Schema.safeParse(raw); return p.success ? { ok: true, value: p.data } : { ok: false, problems: [...] }; },
  jsonSchema,                         // optional
  tools: ['Read'], keepSession: true, // a reviewer that reads its packet and keeps its transcript
  cache: { dir: join(OUT, '.cache/stages') },
  record: (rec) => usage.add(rec),    // one run record per attempt
});
```

`MURRAY_AI_BACKEND` forces `api` or `claude-cli`; `MURRAY_RUN_CLAUDE` names the `claude` binary.

### `@murray/run/models` (v0.2.0)

`loadModels(file)`, `route(cfg, stage)` (the attempts: tier model × `afterFailures`, then `escalateTo` at effort high),
`priceOf(cfg, model, tokens)` (per-million prices from the project's file; 0 for an unpriced model).

### `@murray/run/usage` (v0.2.0)

`RunRecord` (stage, model, backend, tokens by kind, `costUsd`, attempt, escalated, ok, problems, seconds, session, id),
`totals`, `byStage`, `appendUsage(file, rec)` (a `{totals, byStage, entries}` file) for projects without their own usage log.

## Develop

`npm test` (node's own test runner, no dependencies). Tag every release `vX.Y.Z` and add a CHANGELOG line naming the saving
and its measured number, so each project's ledger can cite it.
