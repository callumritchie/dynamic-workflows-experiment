// Verification for the Phase-2 question router.
//   1. aggregate path  - "top opportunity" answered from L3, top row = decide-what-to-watch
//   2. retrieval path  - qualitative question returns >=1 citation, on-topic
//   3. semantic cache  - asking the same question again is a cache hit (0 cost)
//   4. scope integrity - scoped retrieval only cites in-scope sources
//   5. routing         - a "re-run with new dimension" question routes to mini_analysis
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.js';

const p = new Pipeline();
p.reset();
await p.build({ limit: 20 });

// (1) aggregate
const agg = await p.ask('What is the top opportunity we should prioritise?');
assert.equal(agg.path, 'aggregate', '(1) should route to aggregate');
assert.match(agg.answer.text, /decide-what-to-watch/, '(1) aggregate answer names the #1 opportunity');

// (2) retrieval with citations
const ret = await p.ask('What did people say about subscription cost and cancelling services?');
assert.equal(ret.path, 'retrieval', '(2) should route to retrieval');
assert.ok(ret.answer.citations.length >= 1, '(2) retrieval must cite >=1 evidence unit');
const joined = ret.answer.citations.map((c) => c.quote.toLowerCase()).join(' ');
assert.match(joined, /subscri|cancel|pay|month|cost|bill/, '(2) citations should be on-topic');

// (3) semantic cache hit on repeat
const ret2 = await p.ask('What did people say about subscription cost and cancelling services?');
assert.equal(ret2.cache_hit, true, '(3) repeat question should hit the semantic cache');
assert.equal(ret2.cost_estimate_tokens, 0, '(3) cache hit costs 0');

// (4) scope integrity
const scopedIds = ['001.md', '007.md', '012.md'];
const scoped = await p.ask('losing my place when I switch between phone and TV', { ids: scopedIds });
if (scoped.answer.citations.length) {
  assert.ok(
    scoped.answer.citations.every((c) => scopedIds.includes(c.source_id)),
    '(4) scoped retrieval must only cite in-scope sources'
  );
}

// (5) routing of a structural re-analysis request
const mini = await p.ask('Re-run the scoring with a new urgency dimension');
assert.equal(mini.path, 'mini_analysis', '(5) should route to mini_analysis');
assert.ok(mini.answer.mini, '(5) mini_analysis authors/runs a workflow (no longer a bare stub)');

console.log('PASS - router verification');
console.log(`  aggregate:  #1 = ${agg.answer.text.split('\n')[1].trim()}`);
console.log(`  retrieval:  ${ret.answer.citations.length} citations, confidence ${ret.answer.confidence}`);
console.log(`  cache:      repeat question cache_hit=${ret2.cache_hit}`);
console.log(`  scope:      ${scoped.answer.citations.length} citation(s), all in-scope`);
console.log(`  routing:    "re-run...new dimension" -> ${mini.path} (${mini.answer.mini.kind})`);
