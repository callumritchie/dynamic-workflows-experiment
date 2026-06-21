// Verification for the Phase-3 collaboration layer.
//   1. privacy   - user B does NOT reuse user A's un-promoted personal answer
//   2. personal  - user A reuses their OWN personal answer
//   3. promotion - after A promotes, a THIRD user C gets a shared cache hit
//   4. feed       - the promotion is recorded in the project activity feed
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.js';
import { Workspace } from '../src/collab.js';

const p = new Pipeline();
p.reset();
await p.build({ limit: 20 });
const ws = new Workspace(p);
const Q = 'What did people say about subscription cost and cancelling services?';

const tA = ws.newThread({ userId: 'alice', title: 'x' });
const a1 = await ws.ask({ threadId: tA, userId: 'alice', question: Q });
assert.equal(a1.cache_hit, false, 'alice first ask computes');

const tB = ws.newThread({ userId: 'bob', title: 'x' });
const b1 = await ws.ask({ threadId: tB, userId: 'bob', question: Q });
assert.equal(b1.cache_hit, false, '(1) bob must not reuse alice un-promoted personal answer');

const a2 = await ws.ask({ threadId: tA, userId: 'alice', question: Q });
assert.equal(a2.cache_hit, true, '(2) alice reuses her own personal answer');
assert.match(a2.rationale, /personal/, '(2) hit is personal');

ws.promote({ userId: 'alice', kind: 'message', refId: a1.message_id, note: 'shared cost findings' });

const tC = ws.newThread({ userId: 'carol', title: 'x' });
const c1 = await ws.ask({ threadId: tC, userId: 'carol', question: Q });
assert.equal(c1.cache_hit, true, '(3) carol reuses alice PROMOTED (shared) answer');
assert.match(c1.rationale, /shared/, '(3) hit is shared');

const feed = ws.activity();
assert.ok(feed.length >= 1, '(4) activity feed has an entry');
assert.equal(feed[0].actor, 'alice', '(4) feed records alice as promoter');

console.log('PASS - collaboration verification');
console.log(`  privacy:   bob reuse of alice personal = ${b1.cache_hit} (want false)`);
console.log(`  personal:  alice reuse of own = ${a2.cache_hit} (${a2.rationale})`);
console.log(`  promotion: carol hit after promote = ${c1.cache_hit} (${c1.rationale})`);
console.log(`  feed:      ${feed.map((e) => `${e.actor}:${e.kind}`).join(', ')}`);
