import type { ModelsConfig } from './models';
import type { RunRecord } from './usage';

export declare class StageError extends Error {}

/** What a reply check returns: the value to keep, or the problems the retry is told to fix. */
export type CheckResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export interface OneShotOptions<T> {
  /** A stage named in the project's config/models.json. */
  stage: string;
  /** The project's models config, or the path to its config/models.json. */
  models: ModelsConfig | string;
  system: string;
  prompt: string;
  /** Checks the parsed reply (the structured output with `jsonSchema`, else the JSON found in the reply text). */
  check: (raw: unknown) => CheckResult<T>;
  /** A JSON Schema the CLI enforces on the reply (`--json-schema`). Ignored by the API backend. */
  jsonSchema?: object;
  /** Local image files the model should look at (read with the Read tool on the CLI). */
  images?: string[];
  /** More CLI tools to allow (e.g. ["Read"] for a reviewer that reads its packet). */
  tools?: string[];
  /** Let the model search the web and read pages. Never cached. */
  web?: { maxSearches: number; maxFetches: number };
  maxTokens?: number;
  /** Return the last valid reply for the same stage, model and prompt, stored under `dir/<stage>/`. */
  cache?: { dir: string };
  backend?: 'api' | 'claude-cli';
  /** The CLI's working directory (the project root). */
  cwd?: string;
  /** Default 20 minutes. */
  timeoutMs?: number;
  /** Benchmarks only: try this model instead of the stage's tier model. */
  model?: string;
  /** Written into every run record (a film id, a spec name). */
  id?: string;
  /** Called once per attempt (and for a cache hit) with its run record. */
  record?: (rec: RunRecord) => void;
  /** Keep the CLI session's transcript (for metrics that read transcripts). Off by default. */
  keepSession?: boolean;
  /** Save the CLI's raw JSON output here (overwritten each attempt). */
  sessionFile?: string;
  /** The CLI binary (tests); env `MURRAY_RUN_CLAUDE`, else "claude". */
  cli?: string;
}

/**
 * Runs a stage: its tier's model for `escalation.afterFailures` attempts, then once on the escalation model. A retry is
 * shown its own rejected reply and the problems, and asked to change only what they need.
 * Throws StageError when every attempt is rejected.
 */
export declare function oneShot<T>(o: OneShotOptions<T>): Promise<T>;
/** At most `n` calls at once; results in the order of `items`. */
export declare function pool<T, R>(items: T[], n: number, f: (item: T, index: number) => Promise<R>): Promise<R[]>;
/** The JSON object or array in a reply's text (inside a ```json fence if there is one). */
export declare function extractJson(text: string): unknown;
/** `MURRAY_AI_BACKEND` if set, else the API when `ANTHROPIC_API_KEY` is set, else headless Claude Code. */
export declare function backendFromEnv(env?: Record<string, string | undefined>): 'api' | 'claude-cli';
