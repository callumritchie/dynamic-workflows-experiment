// L3a - canonicalize raw slugs into ~6-10 needs BEFORE counting, incrementally.
// On a delta we only classify the NEW raw slugs against the existing canonical set
// (cheap); a full re-cluster fires only when drift crosses a threshold.
//
// classifier seam:
//   classifier.bootstrap(rawUnique) -> { canonical:[{slug,label}], mapping:{raw->{canonical,confidence,method}} }
//        (LLM clustering in prod; offline we seed from outputs/canonical.json)
//   classifier.classify(raw, canonical) -> { canonical, confidence }
//        (LLM/embedding classify in prod; offline = token-overlap heuristic below)

const TOKENS = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
export function jaccard(a, b) {
  const A = TOKENS(a);
  const B = TOKENS(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}
export function heuristicClassify(raw, canonical) {
  let best = null;
  let score = 0;
  for (const c of canonical) {
    const s = Math.max(jaccard(raw.slug, c.slug), jaccard(raw.label, c.label));
    if (s > score) {
      score = s;
      best = c;
    }
  }
  return { canonical: best?.slug ?? null, confidence: +score.toFixed(2) };
}

export function canonicalizeIncremental(
  prev,
  rawUnique,
  classifier,
  { tauAssign = 0.34, tauDrift = 0.4, nAbs = 8 } = {}
) {
  // Cold start (or empty prior): bootstrap a full clustering.
  if (!prev || !prev.canonical?.length) {
    return { ...classifier.bootstrap(rawUnique), version: '1.0', build_reason: 'full_recluster', drift: 0 };
  }

  const mapping = { ...prev.mapping };
  const newOnes = rawUnique.filter((r) => !mapping[r.slug]);

  // No delta -> true no-op: keep the same canonical version (no churn).
  if (newOnes.length === 0) {
    return { ...prev, build_reason: 'unchanged', drift: 0, newSlugs: 0 };
  }

  let unmapped = 0;
  let lowconf = 0;

  for (const r of newOnes) {
    const c = classifier.classify(r, prev.canonical);
    if (!c.canonical || c.confidence < tauAssign) {
      unmapped++;
      mapping[r.slug] = { canonical: '__unmapped__', confidence: c.confidence, method: 'classified_incremental' };
    } else {
      if (c.confidence < 0.5) lowconf++;
      mapping[r.slug] = { canonical: c.canonical, confidence: c.confidence, method: 'classified_incremental' };
    }
  }

  const drift = newOnes.length ? (unmapped + lowconf) / newOnes.length : 0;

  // Drift gate: re-cluster everything only when the delta no longer fits.
  if (newOnes.length && (drift > tauDrift || unmapped >= nAbs)) {
    return {
      ...classifier.bootstrap(rawUnique),
      version: bumpMajor(prev.version),
      build_reason: 'full_recluster',
      drift: +drift.toFixed(2),
      newSlugs: newOnes.length,
    };
  }

  const [maj, min] = prev.version.split('.').map(Number);
  return {
    version: `${maj}.${min + 1}`,
    canonical: prev.canonical,
    mapping,
    build_reason: 'incremental_extend',
    drift: +drift.toFixed(2),
    newSlugs: newOnes.length,
  };
}

function bumpMajor(v) {
  return `${Number(v.split('.')[0]) + 1}.0`;
}
