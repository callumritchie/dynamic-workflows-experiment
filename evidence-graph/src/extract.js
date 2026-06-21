// L2 - per-source structured extraction, content-addressed and memoized.
// Cache key = source.content_hash x EXTRACTOR_VERSION. Re-uploading an unchanged
// source is a pure cache hit (0 tokens). Includes the confidence-gated re-run loop
// ported from the experiment (extractor.strong = stronger model on low confidence).
import { sha256 } from './hash.js';

export const EXTRACTOR_VERSION = 'v1';

// extractor(source) -> { model, confidence, persona, opportunities:[{slug,label,quote,importance,satisfaction}], cost_tokens }
export async function extractSource(store, source, extractor, { tauConf = 0.6 } = {}) {
  const key = `${source.content_hash}.${EXTRACTOR_VERSION}`;
  const cached = store.get('extractions', key);
  if (cached) return { ...cached, _cache: 'hit' };

  let res = await extractor(source);
  let reran = false;
  if (res.confidence < tauConf && typeof extractor.strong === 'function') {
    res = await extractor.strong(source);
    reran = true;
  }

  const artifact = {
    id: sha256(key),
    source_id: source.id,
    source_content_hash: source.content_hash,
    extractor_version: EXTRACTOR_VERSION,
    model: res.model || 'unknown',
    confidence: res.confidence,
    persona: res.persona ?? null,
    // flattened raw_opportunity rows, each tied to a (best-effort) citable unit
    opportunities: res.opportunities.map((o) => ({
      slug: o.slug,
      label: o.label,
      quote: o.quote || '',
      evidence_unit_id: o.evidence_unit_id || locateQuote(source, o.quote),
      importance: o.importance,
      satisfaction: o.satisfaction,
    })),
    cost_tokens: res.cost_tokens || 0,
    reran,
  };
  store.put('extractions', key, artifact);
  return { ...artifact, _cache: 'miss' };
}

// Best-effort: link a quote back to the L1 unit that contains it (citation target).
function locateQuote(source, quote) {
  if (!quote) return null;
  const needle = quote.slice(0, 40).toLowerCase();
  const hit = source.units.find((u) => u.text.toLowerCase().includes(needle));
  return hit ? hit.id : null;
}
