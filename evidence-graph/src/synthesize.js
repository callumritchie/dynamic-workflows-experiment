// Phase 4 - cross-modal triangulation. Given an opportunity (or free-text query),
// gather supporting evidence from EACH modality (qual transcripts, quant metrics, doc
// passages) and corroborate. The generative write-up is the seam; offline we return an
// extractive, cited triangulation so the cross-source reasoning is visible and checkable.
import { cosine } from './embed.js';

export async function triangulate(pipeline, opportunityOrQuery, { k = 3 } = {}) {
  const model = pipeline.store.get('canonical', 'current');
  const opp = model?.canonical.find((c) => c.slug === opportunityOrQuery);
  const slug = opp?.slug ?? null;
  const query = opp ? opp.label : opportunityOrQuery;
  const qvec = await pipeline.embedder(query);

  const topBy = (modalities, filterFn) =>
    pipeline
      .loadUnits({ modalities })
      .filter(filterFn || (() => true))
      .map((u) => ({ u, sim: cosine(qvec, u.vector) }))
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

  const qual = topBy(['qual_transcript'], (u) => u.speaker === 'P').map(citQual);
  const quant = topBy(['quant']).map(citQuant);
  const doc = topBy(['doc']).map(citDoc);

  // qual strength comes from the L3 ranking (not retrieval).
  const ranking = slug ? pipeline.rank() : [];
  const idx = slug ? ranking.findIndex((r) => r.slug === slug) : -1;
  const rankRow = idx >= 0 ? ranking[idx] : null;

  const bits = [];
  if (rankRow) bits.push(`qual ranked #${idx + 1} (freq ${rankRow.frequency}/?, sat ${rankRow.satisfaction})`);
  if (quant.length) bits.push(`quant ${quant[0].metric}=${quant[0].value}${quant[0].unit ? quant[0].unit : ''}`);
  if (doc.length) bits.push(`doc "${doc[0].heading}"`);
  const corroboration = bits.length ? `Triangulated - ${bits.join('; ')}.` : 'No corroborating evidence found.';

  const all = [...qual, ...quant, ...doc];
  const confidence = all.length ? +(all.reduce((s, c) => s + c.similarity, 0) / all.length).toFixed(2) : 0;
  return { slug, opportunity: query, qual, quant, doc, corroboration, confidence };
}

const snip = (t, n = 140) => {
  const c = String(t).replace(/\s+/g, ' ').trim();
  return c.length > n ? `${c.slice(0, n)}...` : c;
};
const citQual = ({ u, sim }) => ({
  modality: 'qual',
  source_id: u.source_id,
  ref: `${u.source_id}#${u.ordinal}`,
  quote: snip(u.text),
  similarity: +sim.toFixed(3),
});
const citQuant = ({ u, sim }) => ({
  modality: 'quant',
  source_id: u.source_id,
  ref: u.value.metric,
  metric: u.value.metric,
  value: u.value.value,
  unit: u.value.unit,
  segment: u.value.segment,
  text: snip(u.text),
  similarity: +sim.toFixed(3),
});
const citDoc = ({ u, sim }) => ({
  modality: 'doc',
  source_id: u.source_id,
  ref: `${u.source_id}:${u.heading}`,
  heading: u.heading,
  text: snip(u.text),
  similarity: +sim.toFixed(3),
});
