// L4 - embedding index over L1 evidence units, content-addressed by
// unit.content_hash x EMBEDDER_VERSION so re-indexing is incremental (skip unchanged).
//
// OFFLINE embedder: a deterministic hashed bag-of-words vector. Cosine similarity then
// tracks lexical overlap - enough to demonstrate filtered retrieval without API auth.
// REAL embedder (seam): swap makeHashEmbedder for an API embedder of the same shape
//   (text) => number[]   e.g. Voyage / OpenAI / a local model. Nothing else changes.
import { sha256 } from './hash.js';

export const EMBEDDER_VERSION = 'hash-v1';

// Generic / discourse / interrogative words dropped from both queries and documents,
// so the offline lexical embedder keys on content terms (this is what a real embedding
// model would learn; here we approximate it with a stoplist).
const STOP = new Set(
  (
    'the a an and or but to of in on at for with it is was were be been being have has had i you we they he she ' +
    'that this these those so just like really kind dont didnt im its also even still right now back around into out off over ' +
    'what when where who why how which did do does done about would could should can cant will wont ' +
    'want wanted say said says tell told think thought know known mean means guess feel felt able ' +
    'people person one two get got getting going gonna lot much many some something anything everything things thing stuff ' +
    'actually yeah yes okay because cause then than there their your youre more most less maybe probably ' +
    'time day night week month thing other another every all any not no but if then else'
  ).split(/\s+/)
);

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Content tokens after stoplist + length filter. Exported so the router can build
// focused, on-topic citation snippets from the same vocabulary the index uses.
export function contentTokens(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 3 && !STOP.has(t));
}

export function makeHashEmbedder(D = 256) {
  const fn = (text) => {
    const v = new Float64Array(D);
    for (const t of contentTokens(text)) v[fnv(t) % D] += 1;
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return Array.from(v, (x) => x / n);
  };
  fn.version = EMBEDDER_VERSION; // 'hash-v1'
  return fn;
}

// vectors are L2-normalized, so cosine == dot product.
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Index one source's units. Returns {embedded, cached}. ASYNC: the embedder may be a
// real model (transformers.js) whose inference is async.
export async function indexSource(store, source, embedder) {
  const ver = embedder.version || EMBEDDER_VERSION;
  let embedded = 0;
  let cached = 0;
  for (const unit of source.units) {
    const key = `${unit.content_hash}.${ver}`;
    if (store.has('embeddings', key)) {
      cached++;
      continue;
    }
    store.put('embeddings', key, {
      unit_id: unit.id,
      source_id: unit.source_id,
      unit_type: unit.unit_type,
      ordinal: unit.ordinal,
      span: unit.span,
      speaker: unit.speaker,
      heading: unit.heading, // doc sections
      value: unit.value, // quant metric_row typed value
      text: unit.text,
      metadata: unit.metadata,
      embedder_version: ver,
      vector: await embedder(unit.text),
    });
    embedded++;
  }
  return { embedded, cached };
}
