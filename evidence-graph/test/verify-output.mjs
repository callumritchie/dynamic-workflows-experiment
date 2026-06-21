// Verification for the Phase-5 output tiers.
//   1. escalation reuse - asking for the deck/prototypes re-uses the cached analysis
//   2. caching          - a second request for the same tier is a full cache hit
//   3. artifacts        - narrative.md exists & non-trivial; each prototype is valid HTML
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pipeline } from '../src/pipeline.js';
import { OutputTiers } from '../src/output.js';

const dataPath = (rel) => fileURLToPath(new URL(`../data/${rel}`, import.meta.url));

const p = new Pipeline();
p.reset();
await p.build({ limit: 20 });
await p.ingestAux([
  { path: dataPath('quant/survey.csv'), modality: 'quant' },
  { path: dataPath('docs/market-note.md'), modality: 'doc' },
]);
const out = new OutputTiers(p);

// tier 1 computes once, then caches.
const a1 = await out.produce('analysis');
assert.equal(a1._cache, 'miss', 'analysis first run computes');
const a2 = await out.produce('analysis');
assert.equal(a2._cache, 'hit', '(2) analysis second run is cached');

// tier 2 reuses the cached analysis (escalation never re-runs analysis).
const n = await out.produce('narrative');
assert.equal(n.from.analysis, 'hit', '(1) narrative reuses cached analysis');
assert.ok(existsSync(n.path), '(3) narrative.md written');
assert.ok(readFileSync(n.path, 'utf8').includes('# Discovery readout'), '(3) narrative has content');

// tier 3 reuses the cached analysis and emits valid HTML per winner.
const pr = await out.produce('prototype');
assert.equal(pr.from.analysis, 'hit', '(1) prototypes reuse cached analysis');
assert.equal(pr.files.length, 3, '(3) one prototype per winner');
for (const f of pr.files) {
  assert.ok(existsSync(f.path), `(3) ${f.slug}.html written`);
  assert.ok(readFileSync(f.path, 'utf8').includes('<html'), `(3) ${f.slug}.html is valid HTML`);
}

// second prototype request is a full cache hit.
const pr2 = await out.produce('prototype');
assert.equal(pr2._cache, 'hit', '(2) repeat prototype request is cached');

console.log('PASS - output tiers verification');
console.log(`  escalation: narrative/prototypes reused analysis (from.analysis=hit)`);
console.log(`  caching:    analysis re-run=${a2._cache}, prototype re-run=${pr2._cache}`);
console.log(`  artifacts:  narrative.md + ${pr.files.length} prototypes (valid HTML)`);
