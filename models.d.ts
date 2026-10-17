export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
export type TierName = 'top' | 'middle' | 'small';

export interface Tier {
  model: string;
  /** null = no thinking (the cheapest call); a level turns thinking on at that effort. */
  effort: Effort;
  /** The model tried once after `escalation.afterFailures` rejected replies. */
  escalateTo?: string;
}

export interface TokenPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A project's config/models.json (other keys, such as notes, are ignored). */
export interface ModelsConfig {
  tiers: Partial<Record<TierName, Tier>>;
  stages: Record<string, { tier: TierName; why?: string }>;
  escalation?: { afterFailures: number };
  /** USD per million tokens by model id; string entries (a unit note) are skipped. */
  prices?: Record<string, TokenPrice | string>;
}

export interface Attempt {
  model: string;
  effort: Effort;
  escalated: boolean;
}

export interface Route {
  stage: string;
  tier: TierName;
  model: string;
  effort: Effort;
  escalateTo?: string;
  attempts: Attempt[];
}

export declare function loadModels(file: string): ModelsConfig;
/** The attempts a stage gets: `afterFailures` on its tier's model, then one on `escalateTo` at effort high. */
export declare function route(cfg: ModelsConfig, stage: string, opts?: { model?: string }): Route;
/** Dollars for one call's tokens; 0 for a model the file doesn't price. */
export declare function priceOf(cfg: ModelsConfig, model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number;
