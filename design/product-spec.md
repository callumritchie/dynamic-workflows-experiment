# Product Spec — Evidence Graph: schemas, caching, and the question router

Companion to the approved plan (`~/.claude/plans/agile-launching-blossom.md`). This pins down the three
load-bearing contracts before any code: (1) the data schemas for the five-layer Evidence Graph, (2) the
content-addressed artifact + cache tables, and (3) the question-router contract. Postgres + pgvector is
assumed; DDL is illustrative (types/constraints that matter, not migration-final).

Two signatures appear throughout and are the backbone of every cache decision:

- **`content_hash`** = `sha256` of a normalized payload (raw bytes for L0, normalized unit text for L1,
  canonical JSON for artifacts). Identity of a *thing*.
- **`corpus_signature`** = stable hash over the multiset of `extraction.id` (equivalently the set of
  source `content_hash`es) currently included in a project. Identity of *what the analysis covers*. Any
  add/change/remove of source data rolls this forward and is what invalidates corpus-dependent caches.
- **`scope_signature`** = canonical hash of a resolved `ScopeFilter` (sorted, normalized). Identity of a
  *slice*. Keys every scoped ranking, derived artifact, and cached answer.

Processor identity is always `*_version` (e.g. `extractor_version`, `embedder_version`,
`normalizer_version`). **Every cache key is `content_hash × processor_version`** — bump the version and
the old artifact is simply not found, so recompute is automatic and old results stay auditable.

---

## 1. Data schemas — the five layers

### Tenancy (context)

```sql
project        (id pk, name, settings jsonb, created_at)
app_user       (id pk, email, name, created_at)
project_member (project_id fk, user_id fk, role,  -- owner|editor|viewer
                primary key (project_id, user_id))
```
Everything below is **project-scoped**. There is no user-scoped analysis artifact — that is what makes
the cache team-wide by construction.

### L0 — Raw sources (immutable, versioned)

```sql
source (
  id            uuid pk,
  project_id    fk,
  modality      text,        -- qual_transcript | quant_table | doc_pdf | ...
  object_uri    text,        -- blob store key (raw bytes live here, not in PG)
  content_hash  text,        -- sha256(raw bytes)  → dedup + addressing
  filename      text, mime text, size_bytes bigint,
  metadata      jsonb,       -- source-level scope: round, collected_at, persona,
                             --   user_group/segment, interviewer, wave...
  supersedes_id uuid null,   -- re-upload of the same logical doc (new version)
  uploaded_by   fk, uploaded_at timestamptz,
  status        text,        -- received|normalized|extracted|indexed|failed
  unique (project_id, content_hash)   -- identical re-upload = no-op
)
```
Re-uploading identical bytes hits the unique constraint and does nothing. A revised version of a doc
gets a new row with `supersedes_id` set; the superseded source is excluded from `corpus_signature` but
kept for audit.

### L1 — Normalized evidence units (the citation + retrieval target)

```sql
evidence_unit (
  id            uuid pk,
  project_id    fk, source_id fk,
  unit_type     text,        -- turn | passage | section | metric_row | series_point
  ordinal       int,         -- position within source
  span          jsonb,       -- {char_start,char_end} | {page,bbox} | {row,col}
  text          text null,   -- qual/doc
  value         jsonb null,  -- quant (typed metric value/series point)
  speaker       text null,   -- qual role (Interviewer | P)
  metadata      jsonb,       -- denormalized scope: modality, persona, segment,
                             --   user_group, round, timestamp  (copied for filtering)
  content_hash  text,        -- sha256(normalized unit) → skip re-embed if unchanged
  normalizer_version text,
  created_at    timestamptz,
  unique (source_id, ordinal, normalizer_version)
)
```
`metadata` is denormalized onto every unit on purpose: filtered ANN search and scope enforcement read it
without joins. This is the only thing that makes "answer over just the budget-conscious segment" cheap.

### L2 — Structured extractions (expensive, cached, incremental)

One **extraction artifact** per source (content-addressed memo), plus a flattened **raw_opportunity**
row table for querying/aggregation.

```sql
extraction (
  id            uuid pk,
  project_id    fk, source_id fk,
  source_content_hash text,
  extractor_version   text,
  model         text, confidence real,
  payload       jsonb,       -- { persona, opportunities:[ {slug,label,quote,
                             --   evidence_unit_id, importance, satisfaction} ] }
  cost_tokens   int, created_at timestamptz,
  unique (source_content_hash, extractor_version)   -- THE memo key
)

raw_opportunity (
  id            uuid pk,
  project_id fk, source_id fk, extraction_id fk,
  slug text, label text, quote text,
  evidence_unit_id fk,       -- ties the score to a citable span
  importance int, satisfaction int,
  -- denormalized scope for fast aggregation/filtering:
  segment text, user_group text, round text, modality text
)
```
Ports the experiment's Extract phase verbatim, including the **confidence-gated re-run loop**: rows with
`extraction.confidence < τ_conf` are re-extracted on a stronger model and the artifact replaced (same
key). Re-uploading an unchanged transcript finds the existing `(source_content_hash, extractor_version)`
row → **0 tokens**.

### L3 — Canonical model + scores (deterministic, versioned, near-free)

```sql
canonical_model (
  id            uuid pk,
  project_id    fk,
  version       text,        -- "major.minor": major=full recluster, minor=incremental extend
  corpus_signature text,     -- which extractions it was built over
  canonical     jsonb,       -- [ {slug,label} ]   (~6-10 needs)
  build_reason  text,        -- full_recluster | incremental_extend
  model text, cost_tokens int, created_at timestamptz
)

canonical_mapping (
  canonical_model_id fk,
  raw_slug      text,
  canonical_slug text,
  assignment_confidence real,
  assignment_method text,    -- clustered | classified_incremental
  primary key (canonical_model_id, raw_slug)
)

ranking_cache (                         -- derived, recomputed in CODE (no model)
  canonical_model_id fk,
  scope_signature text,                 -- whole-corpus default, or any slice
  rows          jsonb,                  -- [ {slug,label,frequency,importance,
                                        --    satisfaction,score,evidence_unit_ids[]} ]
  computed_at   timestamptz,
  primary key (canonical_model_id, scope_signature)
)
```
`ranking_cache` is cheap to fill for *any* scope by filtering `raw_opportunity` and re-running
`frequency × importance × (5 − satisfaction)` in code — the experiment's Score phase. Below this line,
nothing costs tokens.

**Incremental canonicalization algorithm** (the only subtle incremental step):

```
on new extractions E_new (with their raw slugs):
  1. for each NEW unique raw slug:
       classify against current canonical set (cheap classifier given canonical labels)
       → assign (canonical_slug, confidence)  OR  mark UNMAPPED if best_conf < τ_assign
  2. append mappings (method=classified_incremental) as a new MINOR canonical_model version
  3. drift = (#unmapped + #low_confidence_assignments) / #new_slugs
  4. if drift > τ_drift  (or #unmapped > N_abs):
        full re-cluster over ALL raw slugs → new MAJOR version (build_reason=full_recluster)
     else keep the minor version
  5. recompute ranking_cache for affected scopes in code; roll corpus_signature forward
```
Typical re-upload = step 1–2 + step 5 = a few cheap classifications + free aggregation. Full re-cluster
fires only on genuine drift. `τ_assign`, `τ_drift`, `N_abs` are tuned against the eval harness (§4 of
the plan).

### L4 — Embedding index (RAG substrate)

```sql
embedding (
  id            uuid pk,
  project_id    fk,
  target_type   text,        -- evidence_unit | raw_opportunity
  target_id     uuid,
  vector        vector(N),    -- pgvector
  embedder_version text,
  content_hash  text,        -- skip re-embed if unchanged
  metadata      jsonb,       -- modality, segment, user_group, persona, round,
                             --   source_id, unit_type  → ANN pre-filters
  unique (target_id, embedder_version)
)
```
Filtered ANN (`WHERE metadata @> scope ORDER BY vector <-> :q LIMIT k`) is how scoped retrieval stays
both cheap and on-scope.

---

## 2. Artifact & cache tables

The layer tables above are *already* content-addressed caches via their `unique` keys. Two more caches
serve the interactive layer, plus the collaboration/promotion tables.

### Derived-artifact cache (router path c — targeted mini-analyses)

```sql
derived_artifact (
  id            uuid pk, project_id fk,
  kind          text,        -- subset_scoring | segment_comparison | custom_dimension ...
  input_signature text,      -- sha256(analysis_spec + corpus_signature + scope_signature)
  payload       jsonb,
  cost_tokens   int, created_at timestamptz, created_by fk,
  visibility    text,        -- personal | project
  owner_id      fk null,     -- set when visibility=personal
  promoted_from uuid null,   -- thread/message it was promoted from
  unique (project_id, input_signature, coalesce(owner_id,'00000000-...'))
)
```
A mini-analysis is reused whenever the *same spec over the same corpus+scope* recurs — for anyone on the
project once `visibility=project`.

### Semantic query cache (router paths a/b — repeat questions)

```sql
semantic_query_cache (
  id            uuid pk, project_id fk,
  question_text text,
  question_embedding vector(N),
  scope_signature text,
  corpus_signature text,     -- answer is only valid for this corpus state
  answer        jsonb,       -- { text, citations[], derived_from[], confidence }
  cost_tokens   int, created_at timestamptz, created_by fk,
  visibility    text,        -- personal | project
  owner_id      fk null,
  hit_count     int default 0
)
```
Lookup: filter by `project_id` + `corpus_signature` + scope-compatibility, ANN on `question_embedding`
within similarity threshold; on hit, return `answer` and `hit_count += 1`. **Entries whose
`corpus_signature` ≠ current are stale and ignored** (and GC'd), which is what keeps cached answers
honest as data grows.

### Collaboration, memory, promotion

```sql
thread   (id pk, project_id fk, owner_id fk, title, visibility, created_at)   -- personal|project
message  (id pk, thread_id fk, role, content, citations jsonb, cost_tokens, created_at)

promotion (                       -- the low-friction personal→shared layer
  id pk, project_id fk,
  kind text,                      -- thread | message | derived_artifact | query_answer
  ref_id uuid, promoted_by fk, note text, promoted_at timestamptz )

activity_event (                  -- feed of promoted items (NOT raw chat snooping)
  id pk, project_id fk, actor_id fk, type text, ref_id uuid, created_at )
```
Promotion is a single action: it flips a personal artifact/thread to `visibility=project` (or inserts a
project-visible copy/reference) and emits an `activity_event`. From then on teammates' questions hit it
via the project-scoped caches. **Default is personal/private; sharing is explicit and one click** — the
privacy posture the brief asked for.

### Memory-scope summary

| Scope | Holds | Visibility |
|---|---|---|
| Project memory (shared) | canonical model, rankings, project-visible derived artifacts + query cache, pinned findings | all members |
| Personal workspace | private threads, scratch questions, personal derived artifacts | owner only |
| Promotion | action that moves personal → project + logs activity | — |

---

## 3. Question-router contract

The router is the front door for every NL question. It chooses the **cheapest sufficient path** and
always returns citations or an explicit "not in scope."

### Request / response

```ts
RouteRequest {
  project_id: uuid
  question: string
  scope?: ScopeFilter          // omitted ⇒ whole-project corpus
  thread_id: uuid
  user_id: uuid
}

ScopeFilter {                   // every field optional; AND-combined
  source_ids?:  uuid[]          // "these 5 transcripts"
  segments?:    string[]
  user_groups?: string[]        // "busy-parent", "budget-conscious"
  rounds?:      string[]        // "wave 1", "qual round 2"
  modalities?:  ("qual"|"quant"|"doc")[]
  personas?:    string[]
}

RouteDecision {
  path: "aggregate" | "retrieval" | "mini_analysis" | "full_workflow"
  rationale: string
  cache_hit: boolean
  cost_estimate_tokens: number
  answer?: Answer               // present for sync paths / cache hits
  job_id?: string               // present for async (mini_analysis | full_workflow)
}

Answer {
  text: string
  citations: { evidence_unit_id: uuid, source_id: uuid, span: object }[]   // ≥1 required for retrieval
  derived_from: { kind: string, id: uuid }[]   // artifacts the answer used
  confidence: number
}
```

### Routing algorithm

```
0. resolve scope → scope_signature; load current corpus_signature
1. SEMANTIC QUERY CACHE: ANN over semantic_query_cache filtered by
   (project_id, corpus_signature == current, scope ⊇ request.scope) within τ_sim
   → HIT: return cached Answer (cache_hit=true, cost≈0)
2. CLASSIFY intent (rules first; cheap Haiku classifier on ambiguity):
   a) AGGREGATE  — ranking/structured metric already computed
        → read ranking_cache[canonical_model, scope_signature];
          miss ⇒ recompute deterministically from raw_opportunity (free) and cache
   b) RETRIEVAL  — specific / evidence-seeking / qualitative
        → filtered ANN over embedding within scope → top-k units
        → synthesize (Sonnet) over a PROMPT-CACHED stable prefix
          (project system + corpus manifest + canonical model)
        → REQUIRE ≥1 citation; write semantic_query_cache
   c) MINI_ANALYSIS — needs structure not yet computed over a subset
        → input_signature = hash(spec + corpus_signature + scope_signature)
        → derived_artifact hit? return : enqueue bounded sub-workflow over scoped units,
          cache result, return job_id
   d) FULL_WORKFLOW — needs (re)build of canonical model / standing refresh
        → enqueue durable workflow; return job_id
3. SCOPE INTEGRITY: never silently widen scope. If retrieval finds nothing in scope,
   answer "no evidence in the selected {n} sources" — do NOT fall back to the whole corpus.
4. COST ACCOUNTING: record cost_tokens on every path (cache hit ≈ 0; retrieval bounded by k;
   mini_analysis bounded by |scope|) → feeds the cost/cache telemetry dashboards.
```

### Why this satisfies the brief

- **Not lossy**: paths b/c work from actual evidence units with required citations; the canonical
  summary is only ever an *index into* raw passages, never the substrate of the answer.
- **Not wasteful**: paths a + cache hits are ~free; the expensive full workflow is the last resort, not
  the default per question.
- **Scoped**: `ScopeFilter` is honored by aggregation (re-score over filtered rows), retrieval (ANN
  pre-filter), and cache keys (`scope_signature`).
- **Collaborative**: caches and promoted artifacts are project-scoped, so the second person to ask
  anything benefits from the first — with personal-private as the default and one-click promotion.

---

## Open decisions to settle during build (carried from the plan)

- `τ_conf` (re-extract), `τ_assign` / `τ_drift` / `N_abs` (incremental canonicalization), `τ_sim`
  (query-cache hit) — tune empirically against the blind-recovery eval harness.
- Query-cache scope match: exact `scope_signature` vs. superset match (`scope ⊇ request.scope`). Spec
  above assumes superset for broader reuse; revisit if it returns over-broad answers.
- Embedding dimension/model and pgvector-vs-dedicated — defer to corpus-size projections.
- Whether quant `metric_row` units get LLM extraction at all, or are summarized deterministically and
  only embedded for retrieval (likely the latter).
```
