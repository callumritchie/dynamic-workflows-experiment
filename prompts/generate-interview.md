# Interview generation prompt (Haiku)

Human-readable version of the prompt embedded in `workflow/generate-interviews.js`. One Haiku agent runs this per interviewee.

```
Write a realistic customer interview transcript for a product-discovery study.

PRODUCT CONTEXT: Reelay, a streaming aggregator app: one place across all your
streaming subscriptions. The interviewer is doing product discovery about how
people decide what to watch and manage their subscriptions.

INTERVIEWEE: a "<persona>" type (<persona description>).

FORMAT: a natural transcript, 1-2 pages (~600-900 words). Alternate "Interviewer:"
questions and "P:" answers. Use open-ended, jobs-to-be-done style questions. The
person tells specific stories from the last week or two.

THE FOLLOWING FRUSTRATIONS MUST COME THROUGH NATURALLY, in stories, never named
as features or labels:
- <2-3 planted opportunities, expressed as lived frustrations>

RULES:
- Do NOT use the words "opportunity", "feature", or "pain point", and do NOT use
  the label phrases above. Let the frustrations surface through anecdotes.
- Be specific and human: real-ish show names, devices, times of day, who they were with.
- Include some irrelevant texture too, so extraction has to do real work.
- Output ONLY the transcript, starting with "Interviewer:".
```

Personas and planted opportunities live in `workflow/generate-interviews.js` and `ground-truth/answer-key.md`. Analysis prompts (extract / score / ideate / triage / build) are embedded in `workflow/discovery-loop.js`.
