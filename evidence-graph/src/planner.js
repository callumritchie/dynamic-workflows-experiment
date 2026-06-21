// The planner: turn a natural-language request into a WORKFLOW RECIPE.
// This is the "Claude writes the harness per task" step — here a rule-based stand-in
// (an LLM would author novel recipes; offline we recognise a library of lenses). The
// recipe is {kind, label, recipe-steps, needsKey}. Only lenses computable from the
// cached substrate run offline (personas); others are authored but need live extraction.
export function planRequest(question) {
  const s = String(question).toLowerCase();
  if (/persona/.test(s))
    return { kind: 'personas', k: 4, label: 'persona builder', executable: true,
      recipe: ['re-read each interview for its behaviours + needs', 'cluster interviews into personas by shared needs', 'summarise each persona with a representative quote'] };
  if (/journey|\bmap\b|funnel/.test(s))
    return { kind: 'journey', label: 'journey map', needsKey: true,
      recipe: ['extract each moment: stage · emotion · touchpoint', 'order moments into a stage sequence', 'summarise pains + opportunities per stage'] };
  if (/segment|cohort|by (group|type)/.test(s))
    return { kind: 'segment', label: 'segment breakdown', needsKey: true,
      recipe: ['tag each interview’s segment', 'aggregate needs within each segment', 'compare across segments'] };
  if (/dimension|re-?score|urgency|priorit|willing|wtp/.test(s))
    return { kind: 'rescore', label: 'custom re-score', needsKey: true,
      recipe: ['define the new scoring dimension', 're-score the cached opportunities on it', 're-rank'] };
  return { kind: 'unknown', label: 'custom analysis', needsKey: true,
    recipe: ['define an extraction schema for the lens', 'map it over every interview', 'aggregate into the answer'] };
}
