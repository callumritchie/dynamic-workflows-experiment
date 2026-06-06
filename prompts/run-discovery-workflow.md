# Run-the-analysis prompt

Open this repo in Claude Code and paste the block below. Claude writes the dynamic-workflow harness, shows it, and runs it against `./interviews`. You don't run a pre-built script - this is the interface. (`example-workflows/discovery-loop.js` is what Claude tends to generate, for reference.)

After the run, hit `s` to save/promote the harness Claude wrote.

```
ultracode

Run a product-discovery workflow on the interview transcripts in ./interviews.
Show me the harness before you run it.

1. Extract - one Haiku agent per interview file; each reads its file and returns the
   opportunities it found. For each: a kebab-case slug, the persona, one key quote, and
   three 1-5 scores - how often it came up, how important, how satisfied today.
2. Canonicalize (one agent) - the extractors invent a slug per interview, so the same
   need shows up under many slugs. Have one agent cluster the raw opportunities into
   ~6-10 canonical needs and map every raw slug to its canonical one - BEFORE counting.
   (Skip this and frequencies are wrong: one need splits across a dozen slugs.)
3. Score (in code, no model) - aggregate by canonical opportunity;
   rank by frequency x importance x (5 - satisfaction).
4. Ideate - for the top 5 opportunities, a Sonnet agent proposes 3 solutions each;
   a separate judge agent keeps the top 3 by ROI.
5. Build - a Sonnet agent uses the frontend-design skill to write a distinctive,
   production-grade static HTML prototype for each of the 3 winners into ./outputs.
6. Loop - re-run any low-confidence extraction and any prototype that doesn't render.

Set a token budget that fits the run (see below). At the end, print the ranked
opportunity table.
```

## Budget
The smoke test on 10 interviews cost ~370k tokens. Extraction scales with the interview count (~13k each); ideation + the 3 HTML builds are roughly fixed (~230k). So the full 100 lands around 2M. **A 200k cap is far too low for 100.** Set a 2-3M cap, or process a subset (e.g., "the first 20 interviews") for a faster, cheaper demo.

## Keep it blind
Do not paste `ground-truth/answer-key.md`. Run blind, then compare the printed ranking to the key - it should recover `decide-what-to-watch` first.
