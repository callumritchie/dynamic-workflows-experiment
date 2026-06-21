// Real local semantic embedder (no API key, no per-call cost; runs in-process).
// Uses transformers.js with all-MiniLM-L6-v2 (384-dim, mean-pooled, L2-normalized).
// Same call shape as makeHashEmbedder but ASYNC: (text) => Promise<number[]>.
import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false; // pull from the HF hub; cached on disk after first download

export function makeLocalEmbedder({ model = 'Xenova/all-MiniLM-L6-v2', version = 'minilm-l6-v1' } = {}) {
  let pipe = null;
  let loading = null;
  const fn = async (text) => {
    if (!pipe) {
      loading = loading || pipeline('feature-extraction', model);
      pipe = await loading;
    }
    const out = await pipe(String(text ?? ''), { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  };
  fn.version = version;
  fn.warmup = () => fn(' ');
  return fn;
}
