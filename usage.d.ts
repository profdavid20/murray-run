/** What one model call was and cost. Every oneShot attempt writes one (a cached answer too, at no cost). */
export interface RunRecord {
  stage: string;
  model: string;
  backend: 'api' | 'claude-cli';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  escalated: boolean;
  attempt: number;
  ok: boolean;
  /** Why the reply was rejected, for diagnosis and model reviews. */
  problems?: string[];
  /** Answered from the stage cache: no model call, no cost. */
  cached?: boolean;
  /** Wall-clock seconds the call took. */
  seconds?: number;
  /** The CLI session id, when there was one. */
  session?: string;
  /** What the call was for (a film id, a spec name), set by the caller. */
  id?: string;
  at: string;
}

export interface Totals {
  calls: number;
  costUsd: number;
  /** Every input token: fresh, cache reads and cache writes. */
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  escalations: number;
  cached: number;
  failed: number;
}

export declare function writeRunRecord(file: string, rec: RunRecord): void;
export declare function totals(records: RunRecord[]): Totals;
export declare function byStage(records: RunRecord[]): Record<string, Totals>;
/** Appends a record to a usage file `{ totals, byStage, entries }`. */
export declare function appendUsage(file: string, rec: RunRecord): void;
