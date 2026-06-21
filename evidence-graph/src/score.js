// L3b - deterministic scoring. NO model. Recomputable for the whole corpus or any
// scope (subset of source ids) for free. frequency x importance x (5 - satisfaction),
// ported verbatim from the experiment's Score phase.
export function score(rawOpps, mapping, canonicalLabels, scope = {}) {
  const ids = scope.ids ? new Set(scope.ids.map(String)) : null;
  const inScope = ids ? rawOpps.filter((o) => ids.has(String(o.source_id))) : rawOpps;

  const by = {};
  for (const o of inScope) {
    const cs = mapping[o.slug]?.canonical || o.slug;
    if (cs === '__unmapped__') continue;
    const s = (by[cs] ||= { slug: cs, imp: [], sat: [], iv: new Set(), mentions: 0 });
    s.imp.push(o.importance);
    s.sat.push(o.satisfaction);
    s.iv.add(o.source_id);
    s.mentions++;
  }

  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return Object.values(by)
    .map((s) => {
      const frequency = s.iv.size;
      const importance = avg(s.imp);
      const satisfaction = avg(s.sat);
      return {
        slug: s.slug,
        label: canonicalLabels[s.slug] || s.slug,
        frequency,
        mentions: s.mentions,
        importance: +importance.toFixed(2),
        satisfaction: +satisfaction.toFixed(2),
        score: +(frequency * importance * (5 - satisfaction)).toFixed(0),
      };
    })
    .sort((a, b) => b.score - a.score);
}
