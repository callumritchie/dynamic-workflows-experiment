// HARNESS (in-session binding) - discovery-loop, scoped to the first 20 interviews.
//
// This is the harness Claude generated for THIS run. It is the same shape as
// example-workflows/discovery-loop.js, but bound to the tools that actually exist
// in this Claude Code session instead of a separate dynamic-workflow engine:
//
//   agent(prompt, {model, agentType, label})  ==>  the Agent tool
//        (subagent_type = agentType, model = model). Returns the subagent's final
//        message; the orchestrator parses the JSON the subagent was told to emit.
//   parallel(tasks)                           ==>  multiple Agent calls in one turn
//   phase(title) / score-in-code              ==>  Bash (node) - no model
//   build agents write ./outputs/<slug>.html via their own Write tool
//
// Why in-session and not `claude -p`: a freshly spawned `claude` subprocess returns
// 401 (no inherited auth), so the CLI fan-out the original harness assumes is dead
// here. In-session subagents have model + tool access, so they are the real path.
//
// SCOPE for this run: COUNT = 20 (user chose "first 20, one agent each").

const COUNT = 20
const ids = Array.from({ length: COUNT }, (_, i) => String(i + 1).padStart(3, '0'))

// Each extract agent returns this JSON (parsed by the orchestrator):
//   { confidence: 0-1, persona: string,
//     opportunities: [ { slug, label, quote, importance:1-5, satisfaction:1-5 } ] }

// 1. EXTRACT - one Haiku agent per interview (cheap, bounded, repetitive). Agent reads its file.
phase('Extract')
let extracted = await parallel(ids.map(id => () =>
  agent(`Read ./interviews/${id}.md (a customer interview) and extract the distinct underlying
opportunities/needs. For each: a kebab-case slug for the underlying need, the persona type, one
verbatim key quote, importance 1-5, satisfaction-today 1-5. Also return your confidence 0-1.
Respond with ONLY a JSON object.`,
    { model: 'haiku', agentType: 'Explore', label: `extract-${id}` })))

// rerun loop (extraction): retry low-confidence / failed reads once on a stronger model.
const low = extracted.map((e, i) => (!e || e.confidence < 0.6 ? i : -1)).filter(i => i >= 0)
if (low.length) {
  const redo = await parallel(low.map(i => () =>
    agent(`Re-extract carefully from ./interviews/${ids[i]}.md (slug, persona, quote, importance,
satisfaction, confidence). JSON only.`, { model: 'sonnet', agentType: 'Explore', label: `redo-${ids[i]}` })))
  low.forEach((i, k) => { if (redo[k]) extracted[i] = redo[k] })
}

// 2. CANONICALIZE - cluster synonymous slugs BEFORE counting (extraction invents a per-interview
// slug, so one need fragments across many slugs; without this, frequencies are wrong).
phase('Canonicalize')
const raw = []
extracted.filter(Boolean).forEach((e, i) => { for (const o of e.opportunities)
  raw.push({ i, slug: o.slug, label: o.label, quote: o.quote, importance: o.importance, satisfaction: o.satisfaction }) })
const uniqueRaw = [...new Map(raw.map(r => [r.slug, r.label]))].map(([slug, label]) => ({ slug, label }))
const canon = await agent(`These raw opportunity labels came from separate customer interviews; many
are the same underlying need worded differently. Cluster into ~6-10 canonical opportunities (merge
synonyms aggressively). Return {canonical:[{slug,label}], mapping:[{raw,canonical}]} covering EVERY
raw slug. JSON only.\n${JSON.stringify(uniqueRaw)}`, { model: 'sonnet', label: 'canonicalize' })
const toCanon = Object.fromEntries(canon.mapping.map(m => [m.raw, m.canonical]))
const labelOf = Object.fromEntries(canon.canonical.map(c => [c.slug, c.label]))

// 3. SCORE - plain code, no model. frequency = # distinct interviews mentioning the canonical need.
phase('Score')
const byCanon = {}
raw.forEach(r => { const cs = toCanon[r.slug] || r.slug
  const s = (byCanon[cs] ||= { slug: cs, imp: [], sat: [], iv: new Set(), quotes: [] })
  s.imp.push(r.importance); s.sat.push(r.satisfaction); s.iv.add(r.i); if (r.quote) s.quotes.push(r.quote) })
const avg = a => a.reduce((x, y) => x + y, 0) / a.length
const ranking = Object.values(byCanon).map(s => {
  const frequency = s.iv.size, importance = avg(s.imp), satisfaction = avg(s.sat)
  return { slug: s.slug, label: labelOf[s.slug] || s.slug, frequency,
    importance: +importance.toFixed(2), satisfaction: +satisfaction.toFixed(2),
    score: +(frequency * importance * (5 - satisfaction)).toFixed(0) }
}).sort((a, b) => b.score - a.score)

// 4. IDEATE + TRIAGE - 3 ideas per top-5 opportunity; a SEPARATE judge keeps the top 3 by ROI.
phase('Ideate')
const top = ranking.slice(0, 5)
const ideaSets = await parallel(top.map(o => () =>
  agent(`Propose 3 product solutions for Reelay (a streaming aggregator) for this opportunity:
"${o.label}" (frequency ${o.frequency}, importance ${o.importance}, satisfaction ${o.satisfaction}).
Each: name, one-line desc, ROI rationale. JSON only.`, { model: 'sonnet', label: `ideate-${o.slug}` })))
const allIdeas = ideaSets.filter(Boolean).flatMap((s, i) => s.ideas.map(x => ({ ...x, opportunity: top[i].label })))
const winners = await agent(`Triage these ideas; keep the TOP 3 by ROI and feasibility. Return
{top3:[{name,desc,opportunity,why}]}. JSON only.\n${JSON.stringify(allIdeas)}`, { model: 'sonnet', label: 'triage' })

// 5. BUILD + rerun loop - each winner gets a distinctive static HTML prototype; rerun any that
// doesn't render. Each build agent writes its own ./outputs/<slug>.html via its Write tool.
phase('Build')
await parallel(winners.top3.map(idea => {
  const slug = idea.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return () => agent(`Use the frontend-design skill to design and build a single self-contained
static HTML file (inline CSS+JS, no external deps) prototyping "${idea.name}: ${idea.desc}" for
Reelay - distinctive and production-grade, not generic. Save to ./outputs/${slug}.html. Confirm a
valid <html> root; if not, fix and re-save.`, { model: 'sonnet', label: `build-${slug}` })
}))

return { ranking, top3: winners.top3 }
