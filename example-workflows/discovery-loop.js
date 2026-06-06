// EXAMPLE WORKFLOW - reference only. You do NOT run this file directly.
//
// This is roughly what Claude generates when you paste `prompts/run-discovery-workflow.md`
// into Claude Code. The point of dynamic workflows is that Claude writes the harness per
// task; this file is here so you can SEE the shape (and save/promote your own after a run
// with `s`). It runs inside Claude Code's dynamic-workflow engine, not as `node` - the
// agents read files and write prototypes via their own tools.
//
// Shape: extract (cheap model, one agent per interview) -> score (plain code) ->
// ideate + triage (separate judge) -> build prototypes -> rerun loop.

export const meta = {
  name: 'discovery-loop',
  description: 'Interviews -> scored opportunities -> ideas -> HTML prototypes',
  phases: [{ title: 'Extract' }, { title: 'Canonicalize' }, { title: 'Score' }, { title: 'Ideate' }, { title: 'Build' }],
}

const COUNT = 100 // how many interviews in ./interviews to process
const ids = Array.from({ length: COUNT }, (_, i) => String(i + 1).padStart(3, '0'))

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'number' },
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'kebab-case id for the underlying need' },
          label: { type: 'string', description: "the need in the person's words" },
          importance: { type: 'number', description: '1-5' },
          satisfaction: { type: 'number', description: '1-5, today' },
        },
        required: ['slug', 'label', 'importance', 'satisfaction'],
      },
    },
  },
  required: ['confidence', 'opportunities'],
}

// 1. Extract - one CHEAP-model agent per interview (bounded, repetitive work). Agent reads the file.
phase('Extract')
let extracted = await parallel(ids.map(id => () =>
  agent(`Read ./interviews/${id}.md (a customer interview) and extract the distinct underlying opportunities. For each: a kebab-case slug, the label in the person's words, importance 1-5, satisfaction today 1-5. Return your confidence 0-1.`,
    { schema: EXTRACT_SCHEMA, model: 'haiku', agentType: 'Explore', label: `extract-${id}` })))

// rerun loop (extraction): retry low-confidence reads once on a stronger model.
const low = extracted.map((e, i) => (!e || e.confidence < 0.6 ? i : -1)).filter(i => i >= 0)
if (low.length) {
  const redo = await parallel(low.map(i => () =>
    agent(`Extract opportunities again, carefully, from ./interviews/${ids[i]}.md (slug, label, importance 1-5, satisfaction 1-5, confidence).`,
      { schema: EXTRACT_SCHEMA, model: 'sonnet', agentType: 'Explore', label: `extract-redo-${ids[i]}` })))
  low.forEach((i, k) => { if (redo[k]) extracted[i] = redo[k] })
}

// 2. Canonicalize - cluster synonymous opportunities before counting. Extraction invents a
// per-interview slug, so the same need fragments across many; without this, frequencies are wrong.
phase('Canonicalize')
const raw = []
extracted.filter(Boolean).forEach((e, i) => { for (const o of e.opportunities) raw.push({ i, slug: o.slug, label: o.label, importance: o.importance, satisfaction: o.satisfaction }) })
const uniqueRaw = [...new Map(raw.map(r => [r.slug, r.label]))].map(([slug, label]) => ({ slug, label }))
const canon = await agent(`These raw opportunity labels came from separate customer interviews; many are the same underlying need worded differently. Cluster them into canonical opportunities (merge synonyms aggressively, aim for ~6-10 needs). Return 'canonical' [{slug,label}] and 'mapping' [{raw, canonical}] covering every raw slug.\n${JSON.stringify(uniqueRaw)}`,
  { schema: { type: 'object', properties: { canonical: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' }, label: { type: 'string' } }, required: ['slug', 'label'] } }, mapping: { type: 'array', items: { type: 'object', properties: { raw: { type: 'string' }, canonical: { type: 'string' } }, required: ['raw', 'canonical'] } } }, required: ['canonical', 'mapping'] }, label: 'canonicalize' })
const toCanon = Object.fromEntries(canon.mapping.map(m => [m.raw, m.canonical]))
const labelOf = Object.fromEntries(canon.canonical.map(c => [c.slug, c.label]))

// 3. Score - plain code, no model.
phase('Score')
const byCanon = {}
raw.forEach(r => { const cs = toCanon[r.slug] || r.slug; const s = (byCanon[cs] ||= { slug: cs, imp: [], sat: [], iv: new Set() }); s.imp.push(r.importance); s.sat.push(r.satisfaction); s.iv.add(r.i) })
const avg = a => a.reduce((x, y) => x + y, 0) / a.length
const ranking = Object.values(byCanon).map(s => {
  const frequency = s.iv.size, importance = avg(s.imp), satisfaction = avg(s.sat)
  return { slug: s.slug, label: labelOf[s.slug] || s.slug, frequency, importance: +importance.toFixed(2),
    satisfaction: +satisfaction.toFixed(2), score: +(frequency * importance * (5 - satisfaction)).toFixed(0) }
}).sort((a, b) => b.score - a.score)

// 3. Ideate + triage - ideas per top opportunity; a SEPARATE judge keeps the winners.
phase('Ideate')
const top = ranking.slice(0, 5)
const ideaSets = await parallel(top.map(o => () =>
  agent(`Propose 3 product solutions for Reelay (a streaming aggregator) for this opportunity: "${o.label}" (frequency ${o.frequency}, importance ${o.importance}, satisfaction ${o.satisfaction}). Each: name, one-line desc, ROI rationale.`,
    { schema: { type: 'object', properties: { ideas: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' }, roi: { type: 'string' } }, required: ['name', 'desc', 'roi'] } } }, required: ['ideas'] }, model: 'sonnet', label: `ideate-${o.slug}` })))
const allIdeas = ideaSets.filter(Boolean).flatMap((s, i) => s.ideas.map(x => ({ ...x, opportunity: top[i].label })))
const winners = await agent(`Triage these ideas; keep the TOP 3 by ROI and feasibility. Return name, desc, opportunity, why.\n${JSON.stringify(allIdeas)}`,
  { schema: { type: 'object', properties: { top3: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' }, opportunity: { type: 'string' }, why: { type: 'string' } }, required: ['name', 'desc', 'opportunity', 'why'] } } }, required: ['top3'] }, label: 'triage' })

// 4. Build + rerun loop - each winner gets a prototype; rerun any that doesn't render.
// (Each build agent writes its own ./outputs/<slug>.html via its Write tool.)
phase('Build')
await parallel(winners.top3.map(idea => {
  const slug = idea.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return () => agent(`Use the frontend-design skill to design and build a single self-contained static HTML file (inline CSS and JS, no external deps) prototyping "${idea.name}: ${idea.desc}" for Reelay - distinctive and production-grade, not generic. Save it to ./outputs/${slug}.html. Confirm it has a valid <html> root; if not, fix and re-save.`,
    { model: 'sonnet', label: `build-${slug}` })
}))

return { ranking, top3: winners.top3 }
