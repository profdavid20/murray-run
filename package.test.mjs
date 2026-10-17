// The package stays code only and never grows into an engine: no Remotion, no project code, no prompts or keys.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const files = readdirSync(new URL('.', import.meta.url)).filter((f) => /\.(mjs|d\.ts)$/.test(f));

test('no Remotion, React or project imports', () => {
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec === '@anthropic-ai/sdk', `${f} imports ${spec}`);
    }
  }
  const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

test('no prompts, briefs or secrets in the package', () => {
  const all = readdirSync(new URL('.', import.meta.url));
  assert.ok(!all.some((f) => f === '.env' || /^\.env\./.test(f) || /\.(md)$/.test(f) && !['README.md', 'CHANGELOG.md'].includes(f)), all.join(', '));
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /sk-ant-[A-Za-z0-9]/, f);
});
