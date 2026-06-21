// Phase 5 - output tiers. A small cached DAG on top of the Evidence Graph:
//   tier 1 analysis  : ranking (L3) + per-winner triangulation (Phase 4)
//   tier 2 narrative : a cited deck/readout built from the analysis artifact
//   tier 3 prototype : a static HTML concept per winner, built from the analysis artifact
// Each tier is content-addressed on the artifact it consumes, so escalating the output
// (analysis -> deck -> prototypes) re-uses cached lower tiers and never re-runs analysis.
// Generative polish (deck prose, LLM-built UI) is the seam; offline we render deterministically.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, scopeSignature } from './hash.js';

const TOP_N = 5;
const WINNERS = 3;

export class OutputTiers {
  constructor(pipeline) {
    this.p = pipeline;
    this.store = pipeline.store;
    this.dir = join(pipeline.paths.egRoot, 'artifacts');
  }

  // Tier 1 - analysis (ranking + triangulated evidence for the winners).
  async analysis(scope = {}) {
    const corpusSig = this.p.corpusSig();
    const key = sha256(`analysis|${corpusSig}|${scopeSignature(scope)}`);
    const hit = this.store.get('tier-analysis', key);
    if (hit) return { ...hit, _cache: 'hit' };
    const ranking = this.p.rank(scope).slice(0, TOP_N);
    const triangulated = await Promise.all(ranking.slice(0, WINNERS).map((r) => this.p.triangulate(r.slug)));
    const art = { key, kind: 'analysis', corpusSig, ranking, triangulated, created_at: Date.now() };
    this.store.put('tier-analysis', key, art);
    return { ...art, _cache: 'miss' };
  }

  // Tier 2 - narrative/deck (consumes the analysis artifact).
  async narrative(scope = {}) {
    const a = await this.analysis(scope);
    const key = sha256(`narrative|${a.key}`);
    const hit = this.store.get('tier-narrative', key);
    if (hit) return { ...hit, _cache: 'hit', from: { analysis: a._cache } };
    mkdirSync(this.dir, { recursive: true });
    const md = renderDeck(a);
    const path = join(this.dir, 'narrative.md');
    writeFileSync(path, md);
    const art = { key, kind: 'narrative', path, bytes: md.length, created_at: Date.now() };
    this.store.put('tier-narrative', key, art);
    return { ...art, _cache: 'miss', from: { analysis: a._cache } };
  }

  // Tier 3 - prototypes (consumes the analysis artifact; one HTML per winner).
  async prototypes(scope = {}) {
    const a = await this.analysis(scope);
    const key = sha256(`prototype|${a.key}`);
    const hit = this.store.get('tier-prototype', key);
    if (hit) return { ...hit, _cache: 'hit', from: { analysis: a._cache } };
    const protoDir = join(this.dir, 'prototypes');
    mkdirSync(protoDir, { recursive: true });
    const files = a.triangulated.map((t) => {
      const row = a.ranking.find((r) => r.slug === t.slug);
      const html = renderPrototype(row, t);
      if (!html.includes('<html')) throw new Error(`prototype ${t.slug} missing <html> root`); // render guard
      const path = join(protoDir, `${t.slug}.html`);
      writeFileSync(path, html);
      return { slug: t.slug, path };
    });
    const art = { key, kind: 'prototype', files, created_at: Date.now() };
    this.store.put('tier-prototype', key, art);
    return { ...art, _cache: 'miss', from: { analysis: a._cache } };
  }

  produce(tier, scope = {}) {
    if (tier === 'analysis') return this.analysis(scope);
    if (tier === 'narrative' || tier === 'deck') return this.narrative(scope);
    if (tier === 'prototype' || tier === 'prototypes') return this.prototypes(scope);
    throw new Error(`unknown tier: ${tier} (use analysis | narrative | prototype)`);
  }
}

// --- deterministic renderers (generative versions are the seam) ---

function renderDeck(a) {
  const L = [];
  L.push('# Discovery readout');
  L.push('');
  L.push(`_Generated from the Evidence Graph (corpus ${a.corpusSig.slice(0, 12)}). Extractive draft; generative polish is the seam._`);
  L.push('');
  L.push('## Top opportunities');
  L.push('');
  L.push('| # | opportunity | freq | importance | satisfaction | score |');
  L.push('|---|---|------|------------|--------------|-------|');
  a.ranking.forEach((r, i) => L.push(`| ${i + 1} | ${r.slug} | ${r.frequency} | ${r.importance} | ${r.satisfaction} | ${r.score} |`));
  L.push('');
  L.push(`## Evidence (triangulated across qual + quant + secondary, top ${a.triangulated.length})`);
  for (const t of a.triangulated) {
    L.push('');
    L.push(`### ${t.slug}`);
    L.push(t.corroboration);
    if (t.qual[0]) L.push(`- **Voice of customer** [${t.qual[0].ref}]: "${t.qual[0].quote}"`);
    if (t.quant.length) L.push(`- **Quant**: ${t.quant.map((q) => `${q.metric} ${q.value}${q.unit ? q.unit : ''} (${q.segment})`).join('; ')}`);
    if (t.doc.length) L.push(`- **Secondary**: ${t.doc.map((d) => `"${d.heading}"`).join('; ')}`);
  }
  L.push('');
  L.push('## Recommended focus');
  L.push(
    `Prioritise **${a.ranking[0].slug}** (score ${a.ranking[0].score}) - highest frequency and lowest satisfaction, corroborated across qual, quant, and secondary research.`
  );
  return `${L.join('\n')}\n`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderPrototype(row, t) {
  const m = t.quant[0];
  const stat = m ? `${m.value}${m.unit === 'percent' ? '%' : m.unit === 'usd' ? ' USD' : m.unit ? ` ${m.unit}` : ''}` : '—';
  const statLabel = m ? esc(m.metric.replace(/_/g, ' ')) : '';
  const quote = t.qual[0] ? esc(t.qual[0].quote) : '';
  const doc = t.doc[0] ? esc(t.doc[0].heading) : '';
  const title = esc(row.slug);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reelay concept — ${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background: radial-gradient(120% 120% at 80% -10%, #2a1d4d 0%, #0c0c14 55%); color: #ece9f5; min-height: 100vh; padding: 7vw 6vw; }
  .tag { display:inline-block; font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:#b9a7ff; border:1px solid #5b48a8; border-radius:999px; padding:5px 12px; }
  h1 { font-size: clamp(28px,5vw,52px); margin:18px 0 8px; line-height:1.05; }
  .sub { color:#a7a2bd; max-width:46ch; }
  .grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); margin-top:40px; }
  .card { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.09); border-radius:18px; padding:22px; }
  .stat { font-size:44px; font-weight:700; background:linear-gradient(92deg,#c9b8ff,#7b5cff); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .stat-label { color:#a7a2bd; font-size:13px; margin-top:4px; }
  blockquote { border-left:3px solid #7b5cff; padding-left:14px; color:#d7d2ea; font-style:italic; }
  .score { font-variant-numeric:tabular-nums; }
  footer { margin-top:40px; color:#6f6a85; font-size:13px; }
</style>
</head>
<body>
  <span class="tag">Reelay · opportunity concept</span>
  <h1>${title}</h1>
  <p class="sub">${esc(row.label || '')}</p>
  <div class="grid">
    <div class="card"><div class="stat score">${row.score}</div><div class="stat-label">opportunity score · freq ${row.frequency}, sat ${row.satisfaction}/5</div></div>
    <div class="card"><div class="stat">${stat}</div><div class="stat-label">${statLabel}</div></div>
    <div class="card"><blockquote>${quote || 'No quote available.'}</blockquote></div>
  </div>
  <footer>Triangulation: ${esc(t.corroboration)}${doc ? ` · secondary: “${doc}”` : ''}</footer>
</body>
</html>
`;
}
