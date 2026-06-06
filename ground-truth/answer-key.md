# Answer key (ground truth) — NOT given to the analysis workflow

This is the hidden key. We *plant* these opportunities, generate 100 interviews that voice them, then run the discovery workflow blind and check whether it **recovers** this ranking. That recovery is the proof the demo rests on.

Product: **Reelay**, a streaming aggregator (one app across all your subscriptions). Strategy: become the default "what to watch tonight" decision layer. North star: weekly *decided-and-watched* sessions.

## Planted opportunities (intended scores)
Score model (same as the workflow): `frequency × importance × (5 − satisfaction)`. Higher = bigger opportunity.

| id | opportunity (how the persona says it) | persona skew | frequency /100 | importance 1-5 | satisfaction 1-5 | intended score |
|---|---|---|---|---|---|---|
| decide-what-to-watch | "I waste 20 minutes scrolling and give up" | lapsed-browser | 42 | 4.6 | 2.0 | **579** |
| subscription-overload | "I can't track what's on which service" | budget-conscious | 33 | 4.1 | 2.2 | 379 |
| cross-device-resume | "I lose my place moving between TV and phone" | binge-watcher | 26 | 3.8 | 2.6 | 237 |
| new-release-noise | "I miss new releases I'd actually like" | binge-watcher | 22 | 3.5 | 2.7 | 177 |
| price-creep | "prices rise and I can't see if I still use it" | budget-conscious | 17 | 3.9 | 2.3 | 179 |
| kids-controls | "my kid escapes their profile into adult content" | busy-parent | 18 | 4.4 | 2.8 | 174 |
| rewatch-comfort | "I just reopen something I've already seen" | lapsed-browser | 20 | 2.9 | 3.1 | 110 |
| watch-together-remote | "no good way to watch with far-away friends" | social-viewer | 15 | 3.2 | 2.4 | 125 |

**Expected top 3 the workflow should surface:** decide-what-to-watch ≫ subscription-overload > cross-device-resume.

## Personas
- **lapsed-browser** — opens the app, can't decide, bails or rewatches.
- **binge-watcher** — watches a lot, cares about continuity and new releases.
- **busy-parent** — shared TV, kids' safety, little time.
- **budget-conscious** — juggles multiple subs, watches the bill.
- **social-viewer** — wants to watch *with* people.

## How interviews encode the key
Each synthetic interviewee gets one persona + 2–3 opportunities (sampled to hit the frequencies above). The interview voices those pains **in story form, never as labels**. The analysis workflow only sees the transcripts, never this file.
