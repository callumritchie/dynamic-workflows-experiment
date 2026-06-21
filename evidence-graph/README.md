# evidence-graph (Phases 1-5 reference slice)

Runnable prototype of **Phases 1-5** from the plan
(`~/.claude/plans/agile-launching-blossom.md`) and the schemas in
`design/product-spec.md`: a content-addressed Evidence Graph that turns the one-shot
discovery harness into an **incrementally maintained, cheap-to-refresh, queryable,
collaborative** knowledge base.

- **Phase 1** proves the core cost mechanism — *re-uploads and re-runs don't re-burn
  tokens* — via a content-addressed extraction cache, incremental canonicalization, and
  deterministic scoring.
- **Phase 2** adds the L4 embedding index and the **question router**: NL questions are
  answered from cached aggregates, scoped retrieval with citations, or routed to a
  mini/full job — the cheapest sufficient path.
- **Phase 3** adds the **collaboration layer**: the query cache is user-aware
  (personal-private by default), a one-click **promote-to-project** shares a finding, and
  team-wide dedup follows for free — once promoted, any teammate's matching question is a
  shared cache hit.
- **Phase 4** adds **multi-source fusion**: quant (CSV) and doc (markdown/PDF-text)
  normalizers feed the same L1/L4 layers, and `triangulate()` corroborates a qual
  opportunity with quant metrics and doc passages, citing **across modalities**.
- **Phase 5** adds **output tiers**: a cached DAG (analysis → narrative/deck →
  prototypes) where the user picks how far to take it; each tier consumes the prior
  tier's cached artifact, so escalating the output never re-runs the analysis.

It runs without spending tokens by replaying the per-interview extractions already
generated (`outputs/raw-extractions.json`) and using a deterministic local embedder.
The real LLM extractor, embedder, and answer synthesizer are documented seams.

## Run

```bash
cd evidence-graph
node src/cli.js demo        # Phase 1: cold build 15 -> incremental 20 -> re-run -> ranking -> scoped ranking
node src/cli.js askdemo     # Phase 2: aggregate / retrieval+citations / cache hit / scoped / mini-analysis routing
node src/cli.js collabdemo  # Phase 3: personal privacy -> promote-to-project -> team-wide dedup + activity feed
node src/cli.js multidemo   # Phase 4: ingest quant + doc, triangulate opportunities across modalities
node src/cli.js outputdemo  # Phase 5: analysis -> narrative -> prototypes, escalating output reuses cached tiers
npm test                    # run all five regression suites
```

### Split-screen explorer

`viz/explorer.html` — a self-contained, **dependency-free, offline** explainer (open it
directly, or serve it). The screen is split: a **product UI on the right** (a Cursor-style
discovery workspace) and the **backend it triggers on the left** (a 2D flow diagram), kept
in sync. It opens with **"Claude writes the workflow"** (the dynamic-workflow recipe being
authored, then run as a durable pipeline), then steps through first analysis, incremental
upload, instant vs scoped+cited questions (including a "no evidence in scope" beat),
team sharing/promotion, multi-source triangulation, and output tiers — using the real
numbers/citations from the 20-interview run. Plain-language labels by default with a
`Plain | Technical` toggle; nodes are badged LLM (spends tokens) vs code (no model). Use
Play, ←/→, or the "you try" buttons (Send / Promote / Generate deck).

### Live mode (real backend, driven from the UI)

```bash
node server.mjs    # http://127.0.0.1:8100/  (live split-screen UI)
```

A dependency-light Node server wraps the **real** pipeline and serves a split-screen UI
(`viz/live.html`): analyse interviews, ask scoped questions, promote answers, triangulate,
and generate output tiers — each click runs live and lights up the backend flow on the left.
What's actually real here:

- **Extraction** is served from the real Haiku runs (1–20 + the fresh 021–026, 028 = 27
  interviews). With a *valid* `ANTHROPIC_API_KEY` it also extracts new transcripts live
  (`src/extractors/hybrid.js`); the server validates the key on startup and only enables
  the live path if it works.
- **Retrieval is genuinely semantic** — a real embedding model (`all-MiniLM-L6-v2`) runs
  locally via transformers.js (`src/embedders/local.js`), no API key, no per-call cost.
- **Canonicalize, score, router, triangulation, output tiers, cache, promotion** all run
  live in-process.
- Still a stand-in: the final answer prose is **extractive** (returns the cited passages),
  not LLM-generated — that needs a valid model key.

API: `GET /api/state`, `POST /api/build|ask|promote|triangulate|output|aux|reset`.

### Tests

Individual suites: `verify.mjs` (blind recovery + cache + incremental + scope),
`verify-router.mjs` (routing + retrieval + cache), `verify-collab.mjs` (privacy +
promotion), `verify-multi.mjs` (modality isolation + triangulation), `verify-output.mjs`
(tier reuse + cached artifacts).

Other commands:

```bash
node src/cli.js build --reset --limit 20            # fresh build over the first 20 interviews
node src/cli.js build --limit 20                    # again -> all cache hits, 0 tokens
node src/cli.js rank --ids 1,2,3,4,5                # deterministic ranking scoped to a subset (free)
node src/cli.js ask "what is the top opportunity?"  # -> aggregate path (from L3, ~free)
node src/cli.js ask "what did people say about price?" --ids 9,13,14,18   # -> scoped retrieval with citations
node src/cli.js status                              # corpus signature, canonical version, cache size
```

## What maps to what (spec -> code)

| Layer / concept | Spec | Code |
|---|---|---|
| Content hashing + corpus/scope signatures | §1 intro | `src/hash.js` |
| Content-addressed artifact store | §2 | `src/store.js` |
| L0 source + L1 evidence units | §1 L0/L1 | `src/ingest.js` |
| L2 extraction w/ cache + confidence re-run | §1 L2 | `src/extract.js`, `src/extractors/*` |
| L3a incremental canonicalization + drift gate | §1 L3 | `src/canonicalize.js` |
| L3b deterministic scoring (any scope) | §1 L3 | `src/score.js` |
| L4 embedding index (incremental) | §1 L4 | `src/embed.js` |
| Question router (aggregate/retrieval/mini/full) + semantic cache | §3 | `src/router.js` |
| Collaboration: personal/project visibility, promotion, activity feed | §2 | `src/collab.js` |
| Multi-source normalizers (quant CSV, doc md) | §1 L1 | `src/ingest.js`, `data/` |
| Cross-modal triangulation / synthesis | §1.3 fusion | `src/synthesize.js` |
| Output tiers (analysis -> narrative -> prototypes), cached DAG | plan Phase 5 | `src/output.js` |
| Orchestration / manifest / corpus signature | plan Phase 1-5 | `src/pipeline.js` |

## What this slice deliberately stubs (the seams)

- **Extraction model**: replayed offline. Swap in `makeClaudeExtractor` (Haiku fan-out
  + Sonnet `.strong` re-run) behind the same signature.
- **Canonicalization classifier**: the seed clustering (`outputs/canonical.json`) stands
  in for the LLM clusterer + incremental classifier; truly-unseen slugs fall back to a
  token-overlap heuristic. The **drift gate** (`tauDrift` / `nAbs`) and
  major/minor versioning are real.
- **Embedder**: deterministic hashed bag-of-words (`makeHashEmbedder`) instead of an API
  embedding model. Cosine then tracks lexical overlap — enough to demonstrate filtered
  retrieval; the low confidence scores honestly reflect the stand-in.
- **Answer synthesis**: retrieval returns an *extractive* answer (ranked citations). The
  generative synthesis (Sonnet over a prompt-cached prefix) is the documented seam.
- **mini_analysis / full_workflow**: routed with a rationale + job stub; the durable
  workflow engine that would run them is not wired in this slice.
- **Store**: JSON files under `.eg/` instead of Postgres + pgvector + object store.

- **PDF parsing**: the doc normalizer reads markdown as a stand-in for extracted PDF
  text; a real PDF text-extraction step is the seam.
- **Output rendering**: the deck and prototypes are rendered deterministically; the
  generative versions (LLM-written narrative, frontend-design-built UI) are the seam.

**All five plan phases are represented here.** What remains to go from reference slice to
product: replace the seams with real models (extractor, embedder, synthesizers), swap the
JSON `.eg/` store for Postgres + pgvector + object storage, and run the tiers on a durable
workflow engine. The data model, cache keys, incremental logic, and tier wiring stay as-is.
