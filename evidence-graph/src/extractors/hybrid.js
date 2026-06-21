// Hybrid extractor for the live backend.
//   - Cached: replays REAL extractions already produced (outputs/raw-extractions.json for 1-20,
//     plus data/new-extractions.json for the fresh batch). 0 tokens, instant.
//   - Live: if an Anthropic API key is supplied AND an interview has no cached extraction,
//     it extracts for real via the API (Haiku). Activates the moment a valid key is present.
// Same signature as the other extractors: async (source) => { model, confidence, persona, opportunities, cost_tokens }
import { readFileSync, existsSync } from 'node:fs';

const EXTRACT_PROMPT = (text) =>
`Read this customer-discovery interview transcript for "Reelay" (a streaming aggregator app) and extract the distinct underlying opportunities / unmet needs.
For EACH opportunity return: "slug" (kebab-case), "label" (plain words), "importance" (1-5 int), "satisfaction" (1-5 int, 1=very unmet).
Also return "persona" (short) and "confidence" (0-1).
Output ONLY a JSON object: {"persona":"...","confidence":0.0,"opportunities":[{"slug":"...","label":"...","importance":1,"satisfaction":1}]}

TRANSCRIPT:
${text}`;

function loadSeed(paths) {
  const map = new Map();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const e of JSON.parse(readFileSync(p, 'utf8'))) {
      map.set(String(e.i).padStart(3, '0'), e);
    }
  }
  return map;
}

export function makeHybridExtractor({ seedPaths = [], apiKey = null, baseUrl = 'https://api.anthropic.com', model = 'claude-haiku-4-5-20251001' } = {}) {
  const seed = loadSeed(seedPaths);

  async function live(source) {
    if (!apiKey) {
      const err = new Error(`no cached extraction for ${source.id} and no API key`);
      err.pending = true;
      throw err;
    }
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: EXTRACT_PROMPT(source.text) }] }),
    });
    const j = await res.json();
    if (j.error) { const e = new Error(`${j.error.type}: ${j.error.message}`); e.apiError = true; throw e; }
    const txt = (j.content || []).map((c) => c.text || '').join('');
    const parsed = JSON.parse(txt.replace(/^```json?\s*|\s*```$/g, ''));
    return {
      model,
      confidence: parsed.confidence ?? 0.8,
      persona: parsed.persona ?? null,
      opportunities: parsed.opportunities || [],
      cost_tokens: (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0),
      source: 'live',
    };
  }

  const extractor = async (source) => {
    const idx = source.id.replace(/\.md$/, '');
    const entry = seed.get(idx);
    if (entry) {
      return {
        model: 'haiku (cached real run)',
        confidence: entry.confidence ?? 0.9,
        persona: entry.persona ?? null,
        opportunities: entry.opps.map((o) => ({ slug: o.slug, label: o.label, quote: o.quote || '', importance: o.importance, satisfaction: o.satisfaction })),
        cost_tokens: Math.ceil(source.text.length / 4) + 800,
        source: 'cached',
      };
    }
    return live(source);
  };
  extractor.strong = extractor; // re-run uses the same path here
  extractor.availableIds = () => [...seed.keys()];
  extractor.hasLive = !!apiKey;
  return extractor;
}
