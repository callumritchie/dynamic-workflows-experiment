#!/usr/bin/env node
// CLI for the Phase-1 Evidence Graph reference slice.
//   eg build [--limit N] [--reset]   build/refresh over the first N interviews
//   eg rank  [--ids 1,2,3]           print the deterministic ranking (optionally scoped)
//   eg status                        show corpus signature / canonical version / cache size
//   eg demo                          end-to-end narrative: build 15 -> build 20 -> rank -> scoped rank
import { fileURLToPath } from 'node:url';
import { Pipeline } from './pipeline.js';

const dataPath = (rel) => fileURLToPath(new URL(`../data/${rel}`, import.meta.url));

const args = process.argv.slice(2);
const cmd = args[0] || 'demo';
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const fmt = (n) => n.toLocaleString('en-US');
const normalizeIds = (csv) =>
  csv.split(',').map((x) => `${x.trim().padStart(3, '0')}.md`);

function printRanking(rows, title) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${title}`);
  console.log(pad('#', 3) + pad('opportunity', 30) + pad('freq', 7) + pad('imp', 7) + pad('sat', 7) + 'score');
  console.log('-'.repeat(64));
  rows.forEach((r, i) =>
    console.log(
      pad(i + 1, 3) + pad(r.slug, 30) + pad(`${r.frequency}`, 7) + pad(r.importance, 7) + pad(r.satisfaction, 7) + r.score
    )
  );
}

function printBuild(label, res) {
  console.log(
    `${label}: ${res.sources} sources | extracted ${res.computed} (${fmt(res.tokensSpent)} tok` +
      `${res.reran ? `, ${res.reran} re-run` : ''}) | cache-hit ${res.cached} (${fmt(res.tokensSaved)} tok saved) | ` +
      `indexed ${res.indexed} units (${res.indexCached} cached) | ` +
      `canonical v${res.canonical.version} ${res.canonical.build_reason} drift=${res.canonical.drift}`
  );
}

function printAsk(question, d) {
  console.log(`\nQ: ${question}`);
  console.log(`   path=${d.path} cache_hit=${d.cache_hit} cost=${d.cost_estimate_tokens}tok  (${d.rationale})`);
  console.log(
    d.answer.text
      .split('\n')
      .map((l) => `   ${l}`)
      .join('\n')
  );
}

const p = new Pipeline();

if (cmd === 'build') {
  if (has('reset')) p.reset();
  const res = await p.build({ limit: flag('limit') ? Number(flag('limit')) : undefined });
  printBuild('build', res);
  printRanking(res.ranking, 'Ranked opportunities (whole corpus)');
} else if (cmd === 'rank') {
  const ids = flag('ids') ? normalizeIds(flag('ids')) : undefined;
  const rows = p.rank(ids ? { ids } : {});
  printRanking(rows, ids ? `Ranked opportunities (scope: ${ids.join(', ')})` : 'Ranked opportunities (whole corpus)');
} else if (cmd === 'ask') {
  const rest = args.slice(1);
  const idsAt = rest.indexOf('--ids');
  const ids = idsAt >= 0 ? normalizeIds(rest[idsAt + 1]) : undefined;
  const question = (idsAt >= 0 ? rest.slice(0, idsAt) : rest).join(' ');
  if (!question) {
    console.log('usage: eg ask "<question>" [--ids 1,2,3]');
    process.exit(1);
  }
  printAsk(question, await p.ask(question, ids ? { ids } : {}));
} else if (cmd === 'status') {
  console.log(p.status());
} else if (cmd === 'askdemo') {
  p.reset();
  await p.build({ limit: 20 });
  console.log('=== Router demo (corpus: 20 interviews) ===');
  const q1 = 'What is the top opportunity we should prioritise?';
  printAsk(q1, await p.ask(q1)); // -> aggregate (from L3, ~free)
  const q2 = 'What did people say about subscription cost and cancelling services?';
  printAsk(q2, await p.ask(q2)); // -> retrieval with citations
  console.log('\n   (asking the same question again ->)');
  printAsk(q2, await p.ask(q2)); // -> semantic-cache hit
  const q3 = 'What frustrates people about losing their place across devices?';
  printAsk(q3, await p.ask(q3, { ids: normalizeIds('1,7,12,16,17,20') })); // -> scoped retrieval
  const q4 = 'Re-run the scoring with a new urgency dimension';
  printAsk(q4, await p.ask(q4)); // -> mini_analysis stub
} else if (cmd === 'collabdemo') {
  const { Workspace } = await import('./collab.js');
  p.reset();
  await p.build({ limit: 20 });
  const ws = new Workspace(p);
  const Q = 'What did people say about subscription cost and cancelling services?';
  console.log('=== Collaboration demo (Alice, Bob, Carol share one project) ===');

  const tA = ws.newThread({ userId: 'alice', title: 'cost research' });
  const a1 = await ws.ask({ threadId: tA, userId: 'alice', question: Q });
  console.log(`alice asks         -> cache_hit=${a1.cache_hit} cost=${a1.cost_estimate_tokens}tok  (fresh compute)`);

  const tB = ws.newThread({ userId: 'bob', title: 'cost research' });
  const b1 = await ws.ask({ threadId: tB, userId: 'bob', question: Q });
  console.log(`bob asks (same Q)  -> cache_hit=${b1.cache_hit} cost=${b1.cost_estimate_tokens}tok  (privacy: no reuse of alice's personal answer)`);

  ws.promote({ userId: 'alice', kind: 'message', refId: a1.message_id, note: 'shared cost findings' });
  console.log('alice promotes her finding to the project ...');

  const tC = ws.newThread({ userId: 'carol', title: 'cost' });
  const c1 = await ws.ask({ threadId: tC, userId: 'carol', question: Q });
  console.log(`carol asks (same Q)-> cache_hit=${c1.cache_hit} cost=${c1.cost_estimate_tokens}tok  (${c1.rationale})`);

  console.log('\nactivity feed:');
  for (const e of ws.activity()) console.log(`  - ${e.actor} promoted ${e.kind} "${e.note}"`);
} else if (cmd === 'outputdemo') {
  const { OutputTiers } = await import('./output.js');
  const { relative } = await import('node:path');
  const rel = (pth) => relative(process.cwd(), pth);
  p.reset();
  await p.build({ limit: 20 });
  await p.ingestAux([
    { path: dataPath('quant/survey.csv'), modality: 'quant' },
    { path: dataPath('docs/market-note.md'), modality: 'doc' },
  ]);
  const out = new OutputTiers(p);
  console.log('=== Output tiers demo (user picks how far to take it) ===');
  const a = await out.produce('analysis');
  console.log(`tier 1 analysis:   ${a._cache}  (${a.ranking.length} opps, ${a.triangulated.length} triangulated winners)`);
  const n = await out.produce('narrative');
  console.log(`tier 2 narrative:  ${n._cache}  (analysis ${n.from.analysis})  -> ${rel(n.path)}`);
  const pr = await out.produce('prototype');
  console.log(`tier 3 prototypes: ${pr._cache}  (analysis ${pr.from.analysis})  -> ${pr.files.length} files`);
  pr.files.forEach((f) => console.log(`     - ${rel(f.path)}`));
  console.log('\nre-request prototypes (nothing changed):');
  const pr2 = await out.produce('prototype');
  console.log(`tier 3 prototypes: ${pr2._cache}  (analysis ${pr2.from.analysis})  <- all tiers reused, 0 recompute`);
  const { readFileSync } = await import('node:fs');
  console.log('\nnarrative.md preview:');
  console.log(readFileSync(n.path, 'utf8').split('\n').slice(0, 12).map((l) => `   ${l}`).join('\n'));
} else if (cmd === 'multidemo') {
  p.reset();
  await p.build({ limit: 20 });
  const aux = await p.ingestAux([
    { path: dataPath('quant/survey.csv'), modality: 'quant' },
    { path: dataPath('docs/market-note.md'), modality: 'doc' },
  ]);
  console.log('=== Multi-source fusion demo ===');
  console.log(`ingested aux: ${aux.units} units across ${aux.sources} sources (quant + doc), 0-token deterministic\n`);
  for (const slug of ['decide-what-to-watch', 'subscription-overload', 'cross-device-resume']) {
    const t = await p.triangulate(slug);
    console.log(`## ${slug}  (confidence ${t.confidence})`);
    console.log(`   ${t.corroboration}`);
    if (t.qual[0]) console.log(`   qual:  [${t.qual[0].ref}] "${t.qual[0].quote}"`);
    if (t.quant.length) console.log(`   quant: ${t.quant.map((q) => `${q.metric}=${q.value}${q.unit ? q.unit : ''}(${q.segment})`).join(', ')}`);
    if (t.doc.length) console.log(`   doc:   ${t.doc.map((d) => `"${d.heading}"`).join('; ')}`);
    console.log('');
  }
} else if (cmd === 'demo') {
  console.log('=== Evidence Graph Phase-1 demo ===');
  p.reset();
  printBuild('1) cold build, first 15', await p.build({ limit: 15 }));
  console.log('\n   ...5 more interviews uploaded...');
  const inc = await p.build({ limit: 20 });
  printBuild('2) incremental build, 20', inc);
  console.log('   ^ note: only the 5 new sources were extracted; the first 15 were cache hits.');
  console.log('\n3) re-run identical build (no new data):');
  printBuild('   rebuild, 20', await p.build({ limit: 20 }));
  console.log('   ^ everything cached; 0 tokens spent.');
  printRanking(inc.ranking, '4) Ranked opportunities (whole corpus)');
  printRanking(p.rank({ ids: normalizeIds('1,2,3,4,5') }), '5) Scoped ranking (interviews 001-005 only) - recomputed free from cache');
} else {
  console.log('usage: eg [build|rank|status|ask|demo|askdemo|collabdemo|multidemo|outputdemo] [--limit N] [--ids 1,2,3] [--reset]');
  console.log('       eg ask "<question>" [--ids 1,2,3]');
  process.exit(1);
}
