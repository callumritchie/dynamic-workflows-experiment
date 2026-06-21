// REAL extractor seam (not used by the offline demo).
// Same signature as the replay extractor: async (source) => extraction result.
// In production this is the Haiku fan-out from the experiment, with `.strong`
// (Sonnet) wired for the confidence-gated re-run. Left unimplemented on purpose so
// the reference slice stays runnable without API auth; fill in when wiring the API.
//
//   import Anthropic from '@anthropic-ai/sdk'
//   const client = new Anthropic()
//   export function makeClaudeExtractor({ model = 'claude-haiku-4-5-20251001' } = {}) {
//     const run = (mdl) => async (source) => {
//       const msg = await client.messages.create({
//         model: mdl,
//         max_tokens: 1500,
//         system: EXTRACT_SYSTEM,                       // stable -> cache_control
//         messages: [{ role: 'user', content: source.text }],
//       })
//       const parsed = JSON.parse(msg.content[0].text)  // {persona,confidence,opportunities}
//       return { ...parsed, model: mdl, cost_tokens: msg.usage.input_tokens + msg.usage.output_tokens }
//     }
//     const extractor = run(model)
//     extractor.strong = run('claude-sonnet-4-6')        // low-confidence re-run
//     return extractor
//   }
export function makeClaudeExtractor() {
  throw new Error('claude extractor not wired in this reference slice; use makeReplayExtractor');
}
