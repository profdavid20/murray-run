# Changelog

## v0.1.0 — 2026-10-17

- `lock`: the machine-wide render lock, lifted from Video Factory's `src/engine/render-lock.ts` (tested, first-come queue)
  with lesson-videos' blocking wait added (`withRenderLockSync`). Same lock path as before, so old and new code wait for each
  other during the switch. One log for the Mac, `~/Library/Logs/murray-run/render-lock.jsonl`, with a `project` field,
  replacing `~/Library/Logs/video-factory/render-lock.jsonl` and `~/Library/Logs/lesson-videos/render-lock.jsonl` (whose
  turns were merged into it). lesson-videos' renders now queue first come, first served too: before, they only retried
  mkdir every second and could be passed over.
