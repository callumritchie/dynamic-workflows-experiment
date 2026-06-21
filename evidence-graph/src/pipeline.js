// Orchestrates the Phase-1 Evidence Graph: ingest (L0/L1) -> extract w/ cache (L2)
// -> incremental canonicalize (L3a) -> deterministic score (L3b). The interesting
// behaviour is the cache + incremental canonicalization: a re-run or a delta upload
// only spends tokens on genuinely new sources.
import { readdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { ingestFile, ingestQuant, ingestDoc } from './ingest.js';
import { extractSource, EXTRACTOR_VERSION } from './extract.js';
import { makeReplayExtractor } from './extractors/replay.js';
import { canonicalizeIncremental, heuristicClassify } from './canonicalize.js';
import { score } from './score.js';
import { makeHashEmbedder, indexSource, EMBEDDER_VERSION } from './embed.js';
import { route } from './router.js';
import { triangulate as triangulateFn } from './synthesize.js';
import { corpusSignature, scopeSignature } from './hash.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(DIR, '../..');
export const PATHS = {
  egRoot: join(DIR, '..', '.eg'),
  corpus: join(REPO_ROOT, 'interviews'),
  // committed fixtures (real Haiku output for interviews 1-20) so a fresh clone is self-contained
  seedExtractions: join(DIR, '..', 'data', 'base-extractions.json'),
  seedCanonical: join(DIR, '..', 'data', 'canonical.json'),
};

// Classifier seam. Offline: the seed canonicalization (the LLM clustering we already
// ran) stands in for the bootstrap clusterer + the incremental classifier.
function makeSeedClassifier(seedCanon) {
  const seedMap = new Map(seedCanon.mapping.map((m) => [m.raw, m.canonical]));
  return {
    bootstrap(rawUnique) {
      const mapping = {};
      for (const r of rawUnique) {
        if (seedMap.has(r.slug)) {
          mapping[r.slug] = { canonical: seedMap.get(r.slug), confidence: 1, method: 'clustered' };
        } else {
          const c = heuristicClassify(r, seedCanon.canonical);
          mapping[r.slug] = { canonical: c.canonical || '__unmapped__', confidence: c.confidence, method: 'clustered' };
        }
      }
      return { canonical: seedCanon.canonical, mapping };
    },
    classify(r, canonical) {
      if (seedMap.has(r.slug)) return { canonical: seedMap.get(r.slug), confidence: 0.95 };
      return heuristicClassify(r, canonical); // truly-unseen slug -> heuristic fallback
    },
  };
}

export class Pipeline {
  constructor(opts = {}) {
    this.paths = { ...PATHS, ...opts.paths };
    this.store = new Store(this.paths.egRoot);
    this.extractor = opts.extractor || makeReplayExtractor(this.paths.seedExtractions);
    this.embedder = opts.embedder || makeHashEmbedder();
    this.seedCanon = JSON.parse(readFileSync(this.paths.seedCanonical, 'utf8'));
    this.classifier = makeSeedClassifier(this.seedCanon);
  }

  reset() {
    if (existsSync(this.paths.egRoot)) rmSync(this.paths.egRoot, { recursive: true, force: true });
    this.store = new Store(this.paths.egRoot);
  }

  sourceFiles(limit) {
    const files = readdirSync(this.paths.corpus).filter((f) => /^\d+\.md$/.test(f)).sort();
    return (limit ? files.slice(0, limit) : files).map((f) => join(this.paths.corpus, f));
  }

  // Build/refresh over the first `limit` interviews, or an explicit list of `ids`
  // (e.g. ['001','021']). Idempotent + incremental.
  async build({ limit, ids, onStep = () => {} } = {}) {
    const files = ids
      ? ids.map((id) => join(this.paths.corpus, id.endsWith('.md') ? id : `${id}.md`))
      : this.sourceFiles(limit);
    const acc = { computed: 0, cached: 0, tokensSpent: 0, tokensSaved: 0, reran: 0, indexed: 0, indexCached: 0 };
    const sources = [];

    onStep({ t: 'phase', phase: 'extract', msg: `Fanning out one agent per interview — ${files.length} in parallel`, total: files.length });
    let done = 0;
    for (const path of files) {
      const source = ingestFile(path);
      const ext = await extractSource(this.store, source, this.extractor);
      if (ext._cache === 'hit') {
        acc.cached++;
        acc.tokensSaved += ext.cost_tokens;
      } else {
        acc.computed++;
        acc.tokensSpent += ext.cost_tokens;
        if (ext.reran) acc.reran++;
      }
      // L4 - index the source's units (content-addressed; incremental).
      const idx = await indexSource(this.store, source, this.embedder);
      acc.indexed += idx.embedded;
      acc.indexCached += idx.cached;
      sources.push({ id: source.id, content_hash: source.content_hash });
      onStep({ t: 'agent', id: source.id.replace(/\.md$/, ''), status: ext._cache === 'hit' ? 'cached' : 'computed',
        opps: ext.opportunities.length, done: ++done, total: files.length });
    }

    // L3a - incremental canonicalization over all raw slugs seen so far.
    const rawOpps = this.#loadRawOpps(sources);
    const rawUnique = uniqueBy(rawOpps, 'slug').map((o) => ({ slug: o.slug, label: o.label }));
    onStep({ t: 'phase', phase: 'canon', msg: `Grouping ${rawUnique.length} differently-worded needs into canonical themes — before counting` });
    const prev = this.store.get('canonical', 'current');
    const model = canonicalizeIncremental(prev, rawUnique, this.classifier);
    this.store.put('canonical', 'current', model);
    onStep({ t: 'phase', phase: 'canon-done', msg: `${rawUnique.length} raw needs → ${model.canonical.length} canonical (${model.build_reason.replace('_', ' ')})` });

    // corpus signature + manifest of what this state covers.
    onStep({ t: 'phase', phase: 'score', msg: 'Scoring by frequency × importance × (5 − satisfaction) — plain code, no model' });
    const corpusSig = corpusSignature(sources.map((s) => s.content_hash));
    this.store.put('manifest', 'current', { sources, corpusSig, canonicalVersion: model.version });

    // L3b - deterministic whole-corpus ranking, cached by scope_signature.
    const ranking = this.#score(rawOpps, model, {});
    this.store.put('rankings', scopeSignature({}), { scope: {}, corpusSig, rows: ranking });

    return {
      ...acc,
      sources: sources.length,
      corpusSig,
      canonical: { version: model.version, build_reason: model.build_reason, drift: model.drift, count: model.canonical.length },
      ranking,
    };
  }

  // Deterministic ranking for any scope (path-a aggregate). Free; no model.
  rank(scope = {}) {
    const manifest = this.store.get('manifest', 'current');
    if (!manifest) throw new Error('no build yet; run `eg build` first');
    const model = this.store.get('canonical', 'current');
    const rawOpps = this.#loadRawOpps(manifest.sources);
    return this.#score(rawOpps, model, scope);
  }

  // --- router-facing accessors (Phase 2) ---

  corpusSig() {
    const m = this.store.get('manifest', 'current');
    if (!m) throw new Error('no build yet; run `eg build` first');
    return m.corpusSig;
  }

  scopedSourceIds(scope = {}) {
    const m = this.store.get('manifest', 'current');
    if (!m) throw new Error('no build yet; run `eg build` first');
    let ids = m.sources.map((s) => s.id);
    if (scope.ids) ids = ids.filter((id) => scope.ids.includes(id));
    return new Set(ids);
  }

  // L4 units (with vectors) for retrieval, filtered by scope. Spans ALL modalities
  // (transcripts + quant + doc); scope.ids / scope.modalities narrow the candidate set.
  loadUnits(scope = {}) {
    const ver = this.embedder.version || 'hash-v1';
    let units = this.store.list('embeddings').filter((e) => (e.embedder_version || 'hash-v1') === ver);
    if (scope.ids) {
      const ids = new Set(scope.ids);
      units = units.filter((e) => ids.has(e.source_id));
    }
    if (scope.modalities) {
      const m = new Set(scope.modalities);
      units = units.filter((e) => m.has(e.metadata?.modality));
    }
    return units;
  }

  // Ingest non-transcript sources (quant CSV, doc md) into L1/L4. They feed retrieval +
  // triangulation but NOT the opportunity ranking, so they don't change corpus_signature.
  async ingestAux(specs) {
    const acc = { sources: 0, units: 0, cached: 0 };
    const reg = this.store.get('auxsources', 'registry') || { sources: [] };
    for (const { path, modality } of specs) {
      const src = modality === 'quant' ? ingestQuant(path) : ingestDoc(path);
      const idx = await indexSource(this.store, src, this.embedder);
      acc.sources++;
      acc.units += idx.embedded;
      acc.cached += idx.cached;
      if (!reg.sources.find((s) => s.id === src.id)) reg.sources.push({ id: src.id, modality, content_hash: src.content_hash });
    }
    this.store.put('auxsources', 'registry', reg);
    return acc;
  }

  // Cross-modal triangulation for an opportunity (or free-text query).
  triangulate(opportunityOrQuery, opts) {
    return triangulateFn(this, opportunityOrQuery, opts);
  }

  // Answer an NL question via the router (path a/b/c/d).
  ask(question, scope = {}) {
    return route(this, { question, scope });
  }

  status() {
    const manifest = this.store.get('manifest', 'current');
    const model = this.store.get('canonical', 'current');
    return {
      built: !!manifest,
      sources: manifest?.sources.length ?? 0,
      corpusSig: manifest?.corpusSig,
      canonicalVersion: model?.version,
      buildReason: model?.build_reason,
      cachedExtractions: this.store.list('extractions').length,
    };
  }

  #loadRawOpps(sources) {
    const out = [];
    for (const s of sources) {
      const ext = this.store.get('extractions', `${s.content_hash}.${EXTRACTOR_VERSION}`);
      if (!ext) continue;
      for (const o of ext.opportunities) out.push({ source_id: ext.source_id, ...o });
    }
    return out;
  }

  #score(rawOpps, model, scope) {
    const labels = Object.fromEntries(model.canonical.map((c) => [c.slug, c.label]));
    return score(rawOpps, model.mapping, labels, scope);
  }
}

function uniqueBy(arr, key) {
  const seen = new Map();
  for (const x of arr) if (!seen.has(x[key])) seen.set(x[key], x);
  return [...seen.values()];
}
