# CLAUDE.md - dynamic-workflows-experiment

This repo is the experiment behind the Product Compass article *Dynamic Workflows: The Orchestrator Moved Off the Model*. It shows that a dynamic workflow earns its keep on **multi-stage orchestration** (extract -> score -> ideate -> triage -> build), not on a single fan-out.

## How to run the analysis (the point of the repo)

**You generate the workflow yourself from a prompt - you do not run a pre-built script.** That's the whole idea: Claude writes the harness per task.

1. Paste `prompts/run-discovery-workflow.md` into Claude Code (it starts with `ultracode`).
2. Claude writes a dynamic-workflow harness, shows it, and runs it against `./interviews` (100 synthetic transcripts).
3. It prints a ranked opportunity table and writes 3 HTML prototypes to `./outputs`.
4. Save/promote the harness Claude wrote with `s` if you want to reuse it.

`example-workflows/` holds **reference harnesses** (what Claude tends to generate). Read them to understand the shape; you are expected to generate your own, not invoke these.

## The blind test (the payoff)

`ground-truth/answer-key.md` plants the opportunities + intended scores. **Do not feed it to the analysis.** Run the workflow blind, then compare its ranking to the key - it should recover `decide-what-to-watch` as #1, then `subscription-overload`, then `cross-device-resume`. Recovery is the proof.

## Honest scope

Synthetic interviews are a **test harness for the orchestration pattern, not real customer discovery.** They prove the machinery; real interviews carry the truth.

## Cost note

Generating the 100 interviews cost ~2.2M Haiku tokens. The analysis is a separate spend: the smoke test on 10 interviews cost ~370k tokens. Extraction scales with the interview count (~13k/interview); ideation + the 3 HTML builds are roughly fixed (~230k). So the full 100 lands around 2M. A 200k cap is far too low; set a 2-3M cap, or run a subset (e.g. the first 20) for a faster demo. See `outputs/smoke-10.md` for the calibration run.

## Layout

- `interviews/` - 100 synthetic transcripts (the input). Blind.
- `ground-truth/` - product, strategy, the hidden answer key. Never given to the analysis.
- `prompts/` - the generation prompt and the run-the-analysis prompt.
- `example-workflows/` - reference harnesses (generator + analysis). Not for direct invocation.
- `outputs/` - the ranked opportunities + the generated HTML prototypes.

MIT. A local experiment, not a product.
