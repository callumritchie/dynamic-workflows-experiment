// Verification for Phase-4 multi-source fusion.
//   1. modality isolation - scope.modalities returns only that modality's units
//   2. triangulation       - an opportunity gathers qual + quant + doc evidence
//   3. quant typing        - quant citations carry numeric values
//   4. corroboration       - the note cites at least one non-qual modality
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Pipeline } from '../src/pipeline.js';

const dataPath = (rel) => fileURLToPath(new URL(`../data/${rel}`, import.meta.url));

const p = new Pipeline();
p.reset();
await p.build({ limit: 20 });
const aux = await p.ingestAux([
  { path: dataPath('quant/survey.csv'), modality: 'quant' },
  { path: dataPath('docs/market-note.md'), modality: 'doc' },
]);
assert.ok(aux.units > 0, 'aux ingest produced units');

// (1) modality isolation
const quantUnits = p.loadUnits({ modalities: ['quant'] });
assert.ok(quantUnits.length > 0, '(1) quant units present');
assert.ok(quantUnits.every((u) => u.metadata.modality === 'quant'), '(1) modality scope isolates quant');

// (2)+(3)+(4) triangulation across modalities
const t = await p.triangulate('decide-what-to-watch');
assert.ok(t.qual.length >= 1, '(2) has qual evidence');
assert.ok(t.quant.length >= 1, '(2) has quant evidence');
assert.ok(t.doc.length >= 1, '(2) has doc evidence');
assert.ok(t.quant.every((q) => Number.isFinite(q.value)), '(3) quant citations carry numeric values');
assert.match(t.corroboration, /quant|doc/, '(4) corroboration cites a non-qual modality');

console.log('PASS - multi-source verification');
console.log(`  aux ingested: ${aux.units} units (quant + doc)`);
console.log(`  modality scope: ${quantUnits.length} quant-only units`);
console.log(`  triangulate(decide-what-to-watch): qual ${t.qual.length}, quant ${t.quant.length}, doc ${t.doc.length}, conf ${t.confidence}`);
console.log(`  corroboration: ${t.corroboration}`);
