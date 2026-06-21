// Local backend for the live explorer. Wraps the real Evidence Graph pipeline and
// exposes it over HTTP so the UI can drive real runs (and see them). No dependencies.
//
//   node server.mjs            -> http://127.0.0.1:8100/  (live UI)
//
// Extraction is the only model-dependent step: served from REAL cached extractions
// (1-20 + the fresh 021-026,028); if ANTHROPIC_API_KEY is valid it also extracts new
// interviews live. Everything else (canonicalize, score, router, retrieval, triangulate,
// output tiers, cache, promotion) runs live in this process.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pipeline } from './src/pipeline.js';
import { makeHybridExtractor } from './src/extractors/hybrid.js';
import { makeLocalEmbedder } from './src/embedders/local.js';
import { Workspace } from './src/collab.js';
import { OutputTiers } from './src/output.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(DIR, '..');
const PORT = 8100;

const extractor = makeHybridExtractor({
  seedPaths: [join(DIR, 'data', 'base-extractions.json'), join(DIR, 'data', 'new-extractions.json')],
  apiKey: process.env.ANTHROPIC_API_KEY || null,
});
const embedder = makeLocalEmbedder(); // real local semantic embeddings (no key)
let P = new Pipeline({ extractor, embedder });
let ws = new Workspace(P);
let out = new OutputTiers(P);
let tokens = { spent: 0, saved: 0 };
let liveOk = false; // set true only after a real validation ping succeeds
P.reset();

async function validateKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    liveOk = r.status === 200;
  } catch { liveOk = false; }
}

const AUX = [
  { path: join(DIR, 'data', 'quant', 'survey.csv'), modality: 'quant' },
  { path: join(DIR, 'data', 'docs', 'market-note.md'), modality: 'doc' },
];

async function state() {
  const ids = extractor.availableIds();
  let built = false, ranking = null, canonical = null, sources = 0;
  try { const m = P.store.get('manifest', 'current'); if (m) { built = true; sources = m.sources.length;
    canonical = P.store.get('canonical', 'current'); ranking = P.rank(); } } catch {}
  // which interviews exist on disk but have no real extraction (would need a live key)
  let onDisk = [];
  try { onDisk = (await readdir(join(REPO, 'interviews'))).filter((f) => /^\d+\.md$/.test(f)).map((f) => f.replace('.md', '')); } catch {}
  const pending = onDisk.filter((id) => !ids.includes(id));
  return { availableIds: ids, pending, built, sources, tokens, hasLive: liveOk,
    ranking: ranking ? ranking.map((r) => ({ slug: r.slug, label: r.label, score: r.score, frequency: r.frequency, importance: r.importance, satisfaction: r.satisfaction })) : null,
    canonical: canonical ? { version: canonical.version, count: canonical.canonical.length, reason: canonical.build_reason } : null };
}

const handlers = {
  'GET /api/state': async () => state(),

  'POST /api/reset': async () => { P = new Pipeline({ extractor, embedder }); ws = new Workspace(P); out = new OutputTiers(P);
    P.reset(); tokens = { spent: 0, saved: 0 }; return state(); },

  'POST /api/aux': async () => { const r = await P.ingestAux(AUX); return { aux: r, ...(await state()) }; },

  'POST /api/promote': async (body) => { const ev = ws.promote({ userId: body.user || 'you', kind: 'message', refId: body.message_id, note: body.note || 'shared' });
    return { promoted: ev, activity: ws.activity() }; },

  'POST /api/triangulate': async (body) => {
    if (!P.store.get('manifest', 'current')) return { error: 'build first' };
    if (!P.store.list('embeddings').some((e) => e.metadata?.modality === 'quant')) await P.ingestAux(AUX);
    return { triangulation: await P.triangulate(body.slug) };
  },

  'POST /api/output': async (body) => {
    if (!P.store.get('manifest', 'current')) return { error: 'build first' };
    const r = await out.produce(body.tier);
    return { tier: { kind: r.kind, cache: r._cache, from: r.from || null, files: r.files?.map((f) => f.slug) || null, path: r.path || null } };
  },
};

// Streaming (NDJSON) handlers — emit reasoning/progress events as the work happens.
const streamHandlers = {
  'POST /api/build': async (body, emit) => {
    const ids = body.ids && body.ids.length ? body.ids.map((x) => String(x).padStart(3, '0')) : extractor.availableIds();
    emit({ t: 'phase', phase: 'ingest', msg: `Reading & fingerprinting ${ids.length} interviews (skipping any already seen)` });
    const res = await P.build({ ids, onStep: emit });
    tokens.spent += res.tokensSpent; tokens.saved += res.tokensSaved;
    return { t: 'result', build: { sources: res.sources, computed: res.computed, cached: res.cached, tokensSpent: res.tokensSpent, tokensSaved: res.tokensSaved, canonical: res.canonical }, ...(await state()) };
  },
  'POST /api/ask': async (body, emit) => {
    if (!P.store.get('manifest', 'current')) return { t: 'result', error: 'build first' };
    const scope = body.ids && body.ids.length ? { ids: body.ids.map((x) => `${String(x).padStart(3, '0')}.md`) } : {};
    const d = await ws.ask({ threadId: body.thread || 't-live', userId: body.user || 'you', question: body.question, scope, onStep: emit });
    tokens.spent += d.cost_estimate_tokens || 0;
    return { t: 'result', decision: { path: d.path, cache_hit: d.cache_hit, cost: d.cost_estimate_tokens, rationale: d.rationale, answer: d.answer, answer_ref: d.answer_ref, message_id: d.message_id }, tokens };
  },
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (streamHandlers[key]) {
      const body = await readBody(req);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
      const emit = (o) => res.write(JSON.stringify(o) + '\n');
      try { const final = await streamHandlers[key](body, emit); emit(final); }
      catch (e) { emit({ t: 'error', error: String((e && e.message) || e) }); }
      return res.end();
    }
    if (handlers[key]) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await handlers[key](body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    // static (viz/) + root redirect
    let p = url.pathname === '/' ? '/viz/live.html' : url.pathname;
    const file = resolve(DIR, '.' + p);
    if (!file.startsWith(DIR) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    return res.end(data);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
}).listen(PORT, '127.0.0.1', async () => {
  await validateKey();
  console.log(`Evidence Graph live backend on http://127.0.0.1:${PORT}/`);
  console.log(`  ${extractor.availableIds().length} real extractions loaded · live extraction: ${liveOk ? 'ON (key valid)' : 'off (no valid key — cached real data only)'}`);
});

function readBody(req) {
  return new Promise((ok) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
}
