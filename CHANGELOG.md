# Changelog

## v0.2.1 — 2026-10-17

- `call`: `check` may be async (`CheckResult | Promise<CheckResult>`); it is awaited before the retry, so a check
  that writes the reply to disk and compiles or directs it (lesson-videos' film writer: the engine's `direct` and the
  length gate inside the retry) can drive the "It was rejected" prompt. Sync checks are unchanged.

## v0.2.0 — 2026-10-17

- `call`: the one model call (`oneShot`), lifted from Video Factory's `runStage` (lean headless Claude Code with thinking
  off unless the tier sets an effort, retry that fixes the rejected draft, escalation, stage cache, API backend with web
  tools) and lesson-videos' `oneShot` (async spawn so calls overlap, `pool`, `--json-schema`, kept sessions for transcript
  metrics, `tools` for reviewers that read a packet). Same cache key as Video Factory's, so its old stage cache still hits.
- `models`: reads each project's own `config/models.json` (tiers, escalation, prices stay in the project).
- `usage`: the run record every attempt writes (tokens by kind, dollar cost, seconds, session) and usage-file totals.
- Measured in Video Factory (`plan psalm-23-smoke`): $0.186 / 70 s before, $0.142 / 62 s after. A JSON schema rides on every
  call, so pass it only when small: claim-check's reply fell 1,342 → 513 tokens with its 300-character schema, but the
  56,000-character scenes schema made the plan cost $0.70.

## v0.1.0 — 2026-10-17

- `lock`: the machine-wide render lock, lifted from Video Factory's `src/engine/render-lock.ts` (tested, first-come queue)
  with lesson-videos' blocking wait added (`withRenderLockSync`). Same lock path as before, so old and new code wait for each
  other during the switch. One log for the Mac, `~/Library/Logs/murray-run/render-lock.jsonl`, with a `project` field,
  replacing `~/Library/Logs/video-factory/render-lock.jsonl` and `~/Library/Logs/lesson-videos/render-lock.jsonl` (whose
  turns were merged into it). lesson-videos' renders now queue first come, first served too: before, they only retried
  mkdir every second and could be passed over.
