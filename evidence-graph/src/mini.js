// Mini-analysis engine: run a NEW dynamic workflow, on demand, over the already-cached
// corpus — without re-ingesting. Mirrors the discovery shape (map over interviews -> reduce)
// but with a different recipe. `personas` runs for real (reuses cached extractions +
// embeddings, no model key). Other lenses are authored (planner) but need live extraction.
import { cosine, EMBEDDER_VERSION } from './embed.js';
import { EXTRACTOR_VERSION } from './extract.js';
import { sha256 } from './hash.js';
import { planRequest } from './planner.js';

const ARCH = {
  'decide-what-to-watch': 'The overwhelmed decider', 'unified-content-discovery': 'The one-place seeker',
  'know-show-locations': 'The show hunter', 'subscription-overload': 'The cost-watcher',
  'cross-device-resume': 'The multi-screen viewer', 'shared-watching-coordination': 'The social viewer',
  'unified-watchlist': 'The list keeper', 'parental-controls': 'The careful parent',
  'trusted-recommendations': 'The recommendation seeker',
};
const personaName = (top) => (top[0] ? ARCH[top[0].s] || `The ${top[0].s.replace(/-/g, ' ')}` : 'Persona');
const snippet = (t, n = 150) => { const c = String(t).replace(/\s+/g, ' ').trim(); return c.length > n ? `${c.slice(0, n)}…` : c; };
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };

function kmeans(vecs, K) {
  const n = vecs.length; K = Math.min(K, n); const dim = vecs[0]?.length || 0;
  const cents = []; for (let k = 0; k < K; k++) cents.push(vecs[Math.floor((k * n) / K)].slice());
  const assign = new Array(n).fill(0);
  for (let it = 0; it < 14; it++) {
    for (let i = 0; i < n; i++) { let bd = Infinity, bk = 0;
      for (let k = 0; k < K; k++) { let d = 0; for (let j = 0; j < dim; j++) { const x = vecs[i][j] - cents[k][j]; d += x * x; } if (d < bd) { bd = d; bk = k; } }
      assign[i] = bk; }
    const sums = Array.from({ length: K }, () => new Array(dim).fill(0)), cnt = new Array(K).fill(0);
    for (let i = 0; i < n; i++) { cnt[assign[i]]++; for (let j = 0; j < dim; j++) sums[assign[i]][j] += vecs[i][j]; }
    for (let k = 0; k < K; k++) if (cnt[k]) for (let j = 0; j < dim; j++) cents[k][j] = sums[k][j] / cnt[k];
  }
  const clusters = Array.from({ length: K }, () => []);
  assign.forEach((k, i) => clusters[k].push(i));
  return clusters.filter((c) => c.length);
}

export async function runMini(pipeline, question, onStep = () => {}) {
  const plan = planRequest(question);
  onStep({ t: 'step', node: 'router', msg: `No existing answer fits — <b>writing a new “${plan.label}” workflow</b> on the fly` });
  onStep({ t: 'plan', plan });

  if (plan.kind !== 'personas') {
    // Authored, but the new fields aren't in the cache — needs live extraction (a key).
    onStep({ t: 'step', node: 'extract', msg: `This lens needs new per-interview fields — that requires live model extraction`, done: true });
    return { kind: plan.kind, title: plan.label, needsKey: true, recipe: plan.recipe,
      text: `To build a ${plan.label} I'd run this workflow over the interviews: ${plan.recipe.join(' → ')}. Unlike the discovery fields (already cached), this lens extracts new fields per interview, so it needs a valid model key to run live.` };
  }

  // PERSONAS — runs for real over the cached substrate.
  const manifest = pipeline.store.get('manifest', 'current');
  const model = pipeline.store.get('canonical', 'current');
  const canon = model.canonical.map((c) => c.slug);
  const idx = Object.fromEntries(canon.map((s, i) => [s, i]));

  onStep({ t: 'phase', phase: 'extract', total: manifest.sources.length,
    msg: `Re-reading ${manifest.sources.length} interviews through a persona lens (reusing cached evidence — no re-ingest)` });
  const recs = []; let done = 0;
  for (const s of manifest.sources) {
    const ext = pipeline.store.get('extractions', `${s.content_hash}.${EXTRACTOR_VERSION}`);
    const vec = new Array(canon.length).fill(0);
    for (const o of ext?.opportunities || []) {
      const cs = model.mapping[o.slug]?.canonical;
      if (cs && idx[cs] != null) vec[idx[cs]] += o.importance;
    }
    recs.push({ id: s.id, vec: norm(vec) });
    onStep({ t: 'agent', id: s.id.replace(/\.md$/, ''), status: 'cached', opps: (ext?.opportunities || []).length, done: ++done, total: manifest.sources.length });
  }

  onStep({ t: 'step', node: 'canon', msg: `Clustering ${recs.length} interviews into ${plan.k} personas by the needs they share`, code: true });
  const clusters = kmeans(recs.map((r) => r.vec), plan.k);

  const personas = [];
  for (const members of clusters) {
    const ids = members.map((m) => recs[m].id);
    const agg = new Array(canon.length).fill(0);
    members.forEach((m) => recs[m].vec.forEach((v, i) => (agg[i] += v)));
    const top = agg.map((v, i) => ({ s: canon[i], v })).sort((a, b) => b.v - a.v).slice(0, 3).filter((x) => x.v > 0);
    // representative quote: the in-cluster participant passage nearest the top-need
    const qv = await pipeline.embedder((top[0]?.s || '').replace(/-/g, ' '));
    let best = null;
    for (const id of ids) {
      for (const u of pipeline.loadUnits({ ids: [id] }).filter((x) => x.speaker === 'P')) {
        const sim = cosine(qv, u.vector);
        if (!best || sim > best.sim) best = { sim, u };
      }
    }
    personas.push({ name: personaName(top), size: ids.length, needs: top.map((t) => t.s),
      members: ids.map((x) => x.replace(/\.md$/, '')), quote: best ? snippet(best.u.text) : '' });
  }
  personas.sort((a, b) => b.size - a.size);

  const payload = { personas };
  pipeline.store.put('derived', sha256(`personas|${manifest.corpusSig}|${plan.k}`), { kind: 'personas', payload, at: Date.now() });
  onStep({ t: 'step', node: 'answer', msg: `Built ${personas.length} personas`, code: true, done: true });

  return { kind: 'personas', title: `${personas.length} personas`, payload,
    text: `Built ${personas.length} personas from ${manifest.sources.length} interviews, clustered by the needs they share. This was a brand-new workflow, composed on the fly and run over the already-cached interviews.` };
}
