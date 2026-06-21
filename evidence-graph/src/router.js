// The question router - the front door for every NL question. Picks the cheapest
// sufficient path and always returns citations or an explicit "nothing in scope".
// Implements the RouteRequest/RouteDecision contract from design/product-spec.md §3.
//
// Paths implemented offline: semantic-cache hit, aggregate (from L3 ranking),
// retrieval (filtered ANN over L4 + extractive synthesis). mini_analysis / full_workflow
// are routed with a rationale + job stub (Phase 2 doesn't run the durable engine).
// The generative synthesis (Sonnet) is the seam; offline we return an extractive answer.
import { sha256, scopeSignature } from './hash.js';
import { cosine, contentTokens } from './embed.js';
import { runMini } from './mini.js';

const TAU_SIM_CACHE = 0.92; // near-duplicate question threshold

const RE_MINI = /\b(personas?|journey|funnel|segments?|cohorts?|re-?run|re-?analy|re-?score|re-?cluster|new (scoring )?dimension|urgency|willing(ness)? to pay)\b/i;
const RE_FULL = /\b(rebuild|full re-?analysis|re-?build everything|reprocess) \w+/i;
const RE_AGGREGATE =
  /\b(top|rank|ranking|ranked|biggest|highest|priorit|most (important|common|frequent|pressing)|number ?1|#1|score|opportunit(y|ies)|what should we (build|prioriti|focus))\b/i;
const RE_RETRIEVAL_HINT = /\b(say|said|quote|mention|feel|frustrat|complain|what did|example|talk about)\b/i;

export function classify(question) {
  if (RE_MINI.test(question)) return 'mini_analysis';
  if (RE_FULL.test(question)) return 'full_workflow';
  if (RE_AGGREGATE.test(question) && !RE_RETRIEVAL_HINT.test(question)) return 'aggregate';
  return 'retrieval';
}

export async function route(pipeline, { question, scope = {}, userId = 'anon', k = 5, onStep = () => {} } = {}) {
  const scopeSig = scopeSignature(scope);
  const corpusSig = pipeline.corpusSig();

  // 1. SEMANTIC QUERY CACHE - same corpus + same scope + near-duplicate question.
  //    Visibility: a user sees PROJECT (promoted/shared) entries OR their OWN personal
  //    ones - never another user's un-promoted personal answer (privacy by default).
  onStep({ t: 'step', node: 'router', msg: 'Checking shared + personal answer cache' });
  const qvec = await pipeline.embedder(question);
  const visible = (e) => e.visibility === 'project' || e.owner === userId;
  const cached = pipeline.store
    .list('qcache')
    .filter((e) => e.corpusSig === corpusSig && e.scopeSig === scopeSig && visible(e))
    .map((e) => ({ e, sim: cosine(qvec, e.qvec) }))
    .sort((a, b) => b.sim - a.sim)[0];
  if (cached && cached.sim >= TAU_SIM_CACHE) {
    cached.e.answer.hits = (cached.e.answer.hits || 0) + 1;
    pipeline.store.put('qcache', cached.e.key, cached.e);
    onStep({ t: 'step', node: 'answer', msg: `Found a ${cached.e.visibility === 'project' ? 'shared' : 'personal'} cached answer — reusing (0 tokens)`, done: true });
    return decision(cached.e.answer.path, cached.e.answer, {
      cache_hit: true,
      cost: 0,
      rationale: `semantic-cache hit (${cached.e.visibility === 'project' ? 'shared' : 'personal'})`,
      answer_ref: cached.e.key,
    });
  }

  // 2. CLASSIFY + route.
  const path = classify(question);
  const qTokens = new Set(contentTokens(question));
  onStep({ t: 'step', node: 'router', msg: `Classified as “${path}” — choosing the cheapest path that answers it` });
  let answer;
  let cost = 0;
  let rationale;

  if (path === 'aggregate') {
    onStep({ t: 'step', node: 'rank', msg: 'Reading the cached scorecard — no model, no search' });
    const rows = pipeline.rank(scope);
    answer = {
      path,
      text:
        `Top opportunities${hasScope(scope) ? ' (scoped)' : ''} by frequency x importance x (5 - satisfaction):\n` +
        rows.slice(0, 5).map((r, i) => `  ${i + 1}. ${r.slug} - score ${r.score} (freq ${r.frequency}, imp ${r.importance}, sat ${r.satisfaction})`).join('\n'),
      citations: [],
      derived_from: [{ kind: 'ranking', scopeSig }],
      confidence: rows.length ? 0.95 : 0,
    };
    rationale = 'answerable from the cached L3 ranking - no model call';
  } else if (path === 'retrieval') {
    // Evidence = the interviewee's words; interviewer prompts are context, not evidence.
    const all = pipeline.loadUnits(scope);
    const units = all.filter((u) => u.speaker === 'P');
    onStep({ t: 'step', node: 'embed', msg: `Embedding the question and semantically searching ${pipeline.scopedSourceIds(scope).size} in-scope interview(s) · ${(units.length ? units : all).length} passages` });
    const ranked = (units.length ? units : all)
      .map((u) => ({ u, sim: cosine(qvec, u.vector) }))
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

    cost = Math.ceil(question.length / 4); // question embedding; generative synthesis = seam
    onStep({ t: 'step', node: 'answer', msg: ranked.length ? `Ranked top ${ranked.length} passages by similarity (best match ${Math.round((ranked[0]?.sim || 0) * 100)}%) — composing a cited answer` : 'Nothing in scope matched — will say so rather than guess', done: true });
    if (ranked.length === 0) {
      // SCOPE INTEGRITY: never silently widen. Say there's nothing in scope.
      answer = {
        path,
        text: `No evidence in the selected scope (${pipeline.scopedSourceIds(scope).size} sources) matches that question.`,
        citations: [],
        derived_from: [],
        confidence: 0,
      };
      rationale = 'filtered retrieval returned nothing in scope';
    } else {
      answer = {
        path,
        text:
          `${ranked.length} passages across ${new Set(ranked.map((r) => r.u.source_id)).size} source(s) in scope relate to: "${question}".\n` +
          ranked.map((r) => `  - [${r.u.source_id}#${r.u.ordinal}] "${focusSnippet(r.u.text, qTokens)}"`).join('\n'),
        citations: ranked.map((r) => ({
          evidence_unit_id: r.u.unit_id,
          source_id: r.u.source_id,
          span: r.u.span,
          quote: focusSnippet(r.u.text, qTokens),
          similarity: +r.sim.toFixed(3),
        })),
        derived_from: [{ kind: 'embedding', version: 'hash-v1' }],
        confidence: +(ranked.reduce((s, r) => s + r.sim, 0) / ranked.length).toFixed(2),
      };
      rationale = 'specific/qualitative - filtered ANN over L4 within scope, with citations';
    }
  } else if (path === 'mini_analysis') {
    // A new structured lens — author a workflow recipe and run it over the cached corpus.
    const mini = await runMini(pipeline, question, onStep);
    answer = { path, text: mini.text, citations: [], derived_from: [{ kind: 'mini', kind2: mini.kind }], confidence: mini.needsKey ? 0.3 : 0.85, mini };
    rationale = mini.needsKey ? `authored a new “${mini.kind}” workflow — needs live extraction (model key)` : `composed + ran a new on-the-fly “${mini.kind}” workflow over the cached corpus`;
  } else {
    // full_workflow: a durable re-analysis; out of scope for the interactive path.
    answer = { path, text: 'This needs a full durable re-analysis — enqueue the standing workflow.', citations: [], derived_from: [], confidence: 0 };
    rationale = 'classified as full_workflow; runs in the durable engine';
    return decision(path, answer, { cache_hit: false, cost: 0, rationale, job_id: `stub-${sha256(question).slice(0, 8)}` });
  }

  // Write to the semantic query cache as PERSONAL to this user; promotion (collab layer)
  // flips visibility to 'project' so teammates' future asks hit it.
  const key = sha256(`${question}|${scopeSig}|${corpusSig}|${userId}`);
  pipeline.store.put('qcache', key, {
    key, question, qvec, scopeSig, corpusSig, owner: userId, visibility: 'personal', answer, cost,
  });

  return decision(path, answer, { cache_hit: false, cost, rationale, answer_ref: key });
}

function decision(path, answer, { cache_hit, cost, rationale, job_id, answer_ref }) {
  return {
    path,
    rationale,
    cache_hit,
    cost_estimate_tokens: cost,
    answer,
    ...(job_id ? { job_id } : {}),
    ...(answer_ref ? { answer_ref } : {}),
  };
}
const hasScope = (s) => Object.keys(s || {}).length > 0;

// Citation snippet centered on the first matched query token, so quotes read on-topic.
function focusSnippet(text, qTokens, win = 150) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  let at = -1;
  for (const t of qTokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return clean.length > win ? `${clean.slice(0, win)}...` : clean;
  const start = Math.max(0, at - 40);
  const end = Math.min(clean.length, start + win);
  return `${start > 0 ? '...' : ''}${clean.slice(start, end)}${end < clean.length ? '...' : ''}`;
}
