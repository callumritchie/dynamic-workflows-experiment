// Verification / regression for the Phase-1 Evidence Graph.
// Mirrors the plan's "Accuracy & verification" section:
//   1. blind recovery   - ranking #1 is decide-what-to-watch
//   2. cache works       - an identical re-build spends 0 tokens
//   3. incremental        - extending 15 -> 20 extracts EXACTLY the 5 new sources
//   4. scope integrity    - a scoped ranking only counts in-scope sources
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.js';

const p = new Pipeline();
p.reset();

// (1) + (3): cold build of 15, then incremental to 20.
const cold = await p.build({ limit: 15 });
assert.equal(cold.computed, 15, '(3) cold build should extract all 15');
assert.equal(cold.cached, 0, '(3) cold build has nothing cached');

const inc = await p.build({ limit: 20 });
assert.equal(inc.computed, 5, '(3) incremental build should extract exactly the 5 new sources');
assert.equal(inc.cached, 15, '(3) incremental build should hit cache on the first 15');

// (2): identical re-build spends nothing.
const again = await p.build({ limit: 20 });
assert.equal(again.computed, 0, '(2) re-run should extract nothing');
assert.equal(again.tokensSpent, 0, '(2) re-run should spend 0 tokens');

// (1): blind recovery of the planted top opportunity.
assert.equal(again.ranking[0].slug, 'decide-what-to-watch', '(1) #1 opportunity should be decide-what-to-watch');

// (4): scope integrity - subset ranking frequency never exceeds the subset size.
const scoped = p.rank({ ids: ['001.md', '002.md', '003.md'] });
assert.ok(scoped.every((r) => r.frequency <= 3), '(4) scoped frequency must not exceed 3 sources');
assert.ok(scoped.length > 0, '(4) scoped ranking should be non-empty');

console.log('PASS - all verification checks');
console.log(`  blind recovery: #1 = ${again.ranking[0].slug} (score ${again.ranking[0].score})`);
console.log(`  incremental:    15 -> 20 extracted ${inc.computed} new, ${inc.cached} cached`);
console.log(`  cache:          re-run spent ${again.tokensSpent} tokens`);
console.log(`  scope:          3-source slice max frequency = ${Math.max(...scoped.map((r) => r.frequency))}`);
