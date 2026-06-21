// Content addressing + the three signatures the whole cache strategy rests on.
//   content_hash    -> identity of a thing (source bytes, normalized unit, artifact)
//   corpus_signature-> identity of WHAT the analysis covers (invalidates corpus caches)
//   scope_signature -> identity of a slice (keys scoped rankings / answers)
// See design/product-spec.md.
import { createHash } from 'node:crypto';

export const sha256 = (s) =>
  createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');

export const short = (h) => h.slice(0, 12);

// Stable hash over the multiset of extraction content-hashes currently included.
export const corpusSignature = (hashes) => sha256([...hashes].sort().join(','));

// Canonical (sorted, normalized) representation of a scope filter, then hashed.
export function normalizeScope(scope = {}) {
  const norm = {};
  for (const k of Object.keys(scope).sort()) {
    const v = scope[k];
    if (v == null) continue;
    norm[k] = Array.isArray(v) ? [...v].map(String).sort() : v;
  }
  return norm;
}
export const scopeSignature = (scope) => sha256(normalizeScope(scope));
