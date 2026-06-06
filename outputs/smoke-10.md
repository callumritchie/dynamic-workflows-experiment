# Smoke test — 10 interviews

A calibration run of the discovery workflow on the **first 10** interviews (`interviews/001–010.md`), blind to the answer key. It exists to (a) prove the pipeline runs end to end and (b) size the token budget before anyone commits to the full 100.

## Result — recovered ranking

| # | Canonical opportunity | Freq | Imp | Sat | Score |
|---|---|---:|---:|---:|---:|
| 1 | Find what to watch across all my services from one place | 10 | 4.29 | 1.21 | **162** |
| 2 | Pick something quickly instead of endless scrolling | 9 | 4.11 | 1.44 | 132 |
| 3 | See what I'm paying for and cancel unused subscriptions | 7 | 3.33 | 1.67 | 78 |
| 4 | Coordinate / share what to watch with family & friends | 4 | 3.80 | 1.40 | 55 |
| 5 | Resume where I left off across devices | 5 | 3.33 | 2.00 | 50 |
| 6 | Track what I've been recommended / already watched | 4 | 3.40 | 1.40 | 49 |
| 7 | Recommendations that match my taste, not each app's agenda | 3 | 4.00 | 1.60 | 41 |
| 8 | Age-appropriate content / painless parental controls | 2 | 4.00 | 1.00 | 32 |

Score = frequency × importance × (5 − satisfaction).

**Recovery:** the planted #1 — *decide what to watch* — comes back as the clear top need (every one of the 10 interviews, lowest satisfaction). Subscription overload lands in the top 3 and cross-device resume in the top 5, matching the answer key's intent. On only 10 interviews the tail is noisy and *decide what to watch* splits into two sibling needs (discovery vs. decision fatigue); the full 100 sharpens it.

## Prototypes built (top 3 after ROI triage)

- `universal-search-bar.html` — one search field across all linked services (the #1 need).
- `tonight-s-pick.html` — a single daily recommendation, to kill the scroll (the #2 need).
- `smart-resume-card.html` — continue-watching across devices, exact episode + timestamp (#5, highest feasibility).

## What this run caught — the Canonicalize stage

The first pass deduped opportunities by exact slug. The Haiku extractors invent a fresh slug per interview, so **one need fragmented across ~50 slugs from just 10 interviews** (`unified-content-discovery`, `reduce-decision-fatigue`, `infinite-choice-decision-fatigue`, `low-friction-content-selection`, `overcome-choice-paralysis`…). Frequencies were diluted and the ranking only pointed the right way by luck.

The fix is a stage, not a regex: one agent clusters the raw slugs into ~6–10 canonical needs and maps each raw → canonical **before** scoring. After that, 50 slugs collapsed to the 8 above and the recovery is clean. It's also the article's whole point in miniature — the output of one stage (extraction's messy slugs) decides the next (how you count).

## Cost

~370k tokens for 10 interviews. Extraction scales with the interview count (~13k each); canonicalize + ideation + the 3 HTML builds are roughly fixed (~240k). So the full 100 lands around **2M** — set a 2–3M cap. A 200k cap is far too low.
