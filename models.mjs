// Model choice per step, read from each project's own config/models.json (the only place that project's model ids live):
// stage → tier (top/middle/small) → model + effort + escalation model, with prices for the cost of each call.
import { readFileSync } from 'node:fs';

export function loadModels(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// The attempts a stage gets: `afterFailures` on its tier's model, then one on the escalation model (effort high).
// `model` overrides the tier's model (benchmarks only; production always reads the file).
export function route(cfg, stage, { model } = {}) {
  const st = cfg.stages?.[stage];
  if (!st) throw new Error(`Unknown stage "${stage}" (add it to config/models.json)`);
  const base = cfg.tiers?.[st.tier];
  if (!base) throw new Error(`Stage "${stage}" names tier "${st.tier}", which config/models.json doesn't define`);
  const tier = model ? { ...base, model } : base;
  const after = cfg.escalation?.afterFailures ?? 2;
  return {
    stage,
    tier: st.tier,
    model: tier.model,
    effort: tier.effort ?? null,
    escalateTo: tier.escalateTo,
    attempts: [
      ...Array.from({ length: after }, () => ({ model: tier.model, effort: tier.effort ?? null, escalated: false })),
      ...(tier.escalateTo ? [{ model: tier.escalateTo, effort: 'high', escalated: true }] : []),
    ],
  };
}

// Dollars for one call's tokens at the file's per-million prices; 0 for a model the file doesn't price.
export function priceOf(cfg, model, u) {
  const p = cfg.prices?.[model];
  if (!p || typeof p === 'string') return 0;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}
