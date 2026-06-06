// Generator: a small dynamic workflow that fans out Haiku agents to write
// synthetic customer interviews from a planted answer key.
// Run via the Workflow tool: { scriptPath: ".../workflow/generate-interviews.js", args: { count: 100 } }
// Returns [{ id, persona, planted, content }]. The caller writes each to interviews/<id>.md.

export const meta = {
  name: 'generate-synthetic-interviews',
  description: 'Fan out Haiku agents to write synthetic Reelay discovery interviews from a planted key',
  phases: [{ title: 'Generate' }],
}

const PRODUCT = `Reelay, a streaming aggregator app: one place across all your streaming subscriptions. The interviewer is doing product discovery about how people decide what to watch and manage their subscriptions.`

const PERSONAS = {
  'lapsed-browser': 'opens the app, struggles to decide, often bails or rewatches something familiar',
  'binge-watcher': 'watches a lot; cares about continuity across devices and not missing new releases',
  'busy-parent': 'shared family TV, worries about kids and content, very little free time',
  'budget-conscious': 'juggles several subscriptions and watches the monthly bill',
  'social-viewer': 'wants to watch together with friends and family who live elsewhere',
}

// Planted opportunities + intended frequency (out of 100). The analysis workflow never sees this.
const OPPS = [
  { id: 'decide-what-to-watch', say: 'wastes ~20 minutes scrolling and often gives up', freq: 42 },
  { id: 'subscription-overload', say: "can't track which show is on which service", freq: 33 },
  { id: 'cross-device-resume', say: 'loses their place moving between the TV and the phone', freq: 26 },
  { id: 'new-release-noise', say: "misses new releases they'd actually have liked", freq: 22 },
  { id: 'rewatch-comfort', say: "ends up reopening something they've already seen", freq: 20 },
  { id: 'kids-controls', say: 'their kid escapes the kids profile into adult content', freq: 18 },
  { id: 'price-creep', say: "prices keep rising and they can't tell if they still use a service", freq: 17 },
  { id: 'watch-together-remote', say: 'has no good way to watch with far-away friends', freq: 15 },
]

const personaKeys = Object.keys(PERSONAS)
const count = (args && args.count) || 100

// Deterministic plan (no Math.random): distribute each opportunity's occurrences
// across interviewees by even stride, max 3 opps per interviewee.
function buildPlan(n) {
  const assign = Array.from({ length: n }, () => [])
  for (const o of OPPS) {
    const occ = Math.max(1, Math.round((o.freq / 100) * n))
    for (let k = 0; k < occ; k++) {
      const start = Math.floor((k * n) / occ) % n
      for (let j = 0; j < n; j++) {
        const t = (start + j) % n
        if (assign[t].length < 3 && !assign[t].some(x => x.id === o.id)) { assign[t].push(o); break }
      }
    }
  }
  return assign.map((opps, i) => ({
    id: String(i + 1).padStart(3, '0'),
    persona: personaKeys[i % personaKeys.length],
    opps: opps.length ? opps : [OPPS[i % OPPS.length]],
  }))
}

function interviewPrompt(p) {
  const pains = p.opps.map(o => `- ${o.say}`).join('\n')
  return `Write a realistic customer interview transcript for a product-discovery study.

PRODUCT CONTEXT: ${PRODUCT}

INTERVIEWEE: a "${p.persona}" type (${PERSONAS[p.persona]}).

FORMAT: a natural transcript, 1-2 pages (~600-900 words). Alternate "Interviewer:" questions and "P:" answers. Use open-ended, jobs-to-be-done style questions. The person tells specific stories from the last week or two.

THE FOLLOWING FRUSTRATIONS MUST COME THROUGH NATURALLY, in stories, never named as features or labels:
${pains}

RULES:
- Do NOT use the words "opportunity", "feature", or "pain point", and do NOT use the label phrases above. Let the frustrations surface through anecdotes and feelings.
- Be specific and human: real-ish show names, devices, times of day, who they were with.
- Include some irrelevant texture too (not every line is a frustration) so extraction has to do real work.
- Output ONLY the transcript, starting with "Interviewer:".`
}

const plan = buildPlan(count)
log(`Generating ${plan.length} interviews with Haiku...`)

const texts = await parallel(plan.map(p => () =>
  agent(interviewPrompt(p), { model: 'haiku', label: `interview-${p.id} (${p.persona})` })
))

return plan.map((p, i) => ({
  id: p.id,
  persona: p.persona,
  planted: p.opps.map(o => o.id),
  content: texts[i],
}))
