# Hybrid retrieval experiment

Branch: `feat/pdf-hybrid-retrieval`. Local pre-experiment snapshot:
`refs/codex/baselines/pdf-hybrid-retrieval` (`ba04ee5664472c15e90d43bbc58e3bc74148f519`).
The snapshot preserves earlier uncommitted source changes without changing `main`.

## Scope and acceptance

Single-document keyword/semantic/hybrid retrieval feeds the existing exact evidence,
annotation, navigation and multi-step history pipeline. Model edits continue to enter
the shared draft directly; saving still requires confirmation. No second document,
draft or anchor registry is introduced.

The first implementation indexes extracted text, reports OCR/quality/empty-page
coverage separately, and never claims images or formulas have been understood.
Page-image retrieval and reranking remain extension work, not release claims.

1. [x] Validate the supplied local MLX embedding runtime with synthetic bilingual data.
2. [x] Original-offset chunks, BM25, cosine ranking and protected reciprocal-rank fusion.
3. [x] Implement bounded, resumable indexing, rebuildable cache and cancellation fencing; focused service tests pass.
4. [x] Implement dynamic embedding registration/settings and the existing evidence/tool integration.
5. [x] Run the frozen synthetic retrieval evaluation and component/cache performance comparison below.
6. [x] Verify the integrated tree: source/test/benchmark types, production build and all 1,256 Node tests pass with no skips; browser replay passes 37/37, including existing exact-navigation/back-history interactions.

Follow-up product evaluation, outside this implementation gate: real Desktop
reading sessions and broader, independently authored document/query sets. No
live Desktop was restarted or configured by this experiment.

The public-tool interface was subsequently updated to short search IDs as described
below. The benchmark measurements and 1,256-test / 37-browser-test acceptance
counts recorded here describe the original experiment run; they have not been
relabelled as validation of that interface update.

The short-ID update was verified separately on 2026-10-25:

- Source, test and benchmark type checks, production build and all 1,276 Node
  tests pass with no skips. Regression cases cover dense-page and multi-page
  continuation, preserved hybrid scope/options, invalid or foreign handles,
  expiry, concurrency, cancellation and suspended-document leases.
- The full 37-case browser suite passes before branch publication, including
  evidence-card navigation and exact evidence annotation/navigation with
  multi-level Reader history.
- The built embedding SDK with local Qwen and a generated six-page PDF passes
  the original-text evidence, shared-draft annotation and navigation checks.
  A separate one-input-batch probe requires two calls: the second sends only
  `searchId` and reaches `complete`. This is a real-model continuation check,
  not a new large-document performance or retrieval-quality claim.

## Runtime decision

The supplied `mlx-lm-local-demo` has a cached
`mlx-community/Qwen3-Embedding-0.6B-8bit` model. Its installed convenience helper
truncates to 512 tokens by default. The standalone
[`scripts/local-embedding-server.py`](../scripts/local-embedding-server.py) reuses
that Python environment and cached model directly, without the demo's vector
database, ingestion endpoints or conversation model. It tokenizes with truncation
disabled and rejects oversized requests.

The tested model revision is `b8d7100604f51da6d14eab4dd1805f596fa1ce3f`, producing
1,024-dimensional vectors. Query encoding adds the configured Qwen retrieval
instruction; document encoding does not. The launcher permits at most 8 inputs,
8,192 tokens per input and 16,384 padded tokens per batch. The adapter also bounds
each original input to 16,000 UTF-16 units. Character limits do not replace the
server's token check. Model metadata and response revision must match the selected
encoding identity; an arbitrary endpoint with an OpenAI-shaped response alone is
not sufficient.

Synthetic runtime probes encoded 2,028 tokens across long inputs, including
different tails after token 512; those tails produced distinct vectors (L2
distance 0.9367). An over-budget input was rejected with HTTP 422 rather than
truncated. These checks validate input handling, not general embedding quality.
Cancelling an active/queued request returned to the caller in 4.75 ms in one
probe, and a subsequent request completed in 81.3 ms. A running Metal operation
can continue until its bounded batch finishes despite that fast caller return.

From the plugin checkout on a compatible Apple Silicon machine:

```sh
/absolute/path/to/mlx-lm-local-demo/.venv/bin/python scripts/local-embedding-server.py --port 8001
```

The Python environment must already contain MLX embedding, FastAPI, Uvicorn and
their dependencies, with the pinned model cached. The launcher binds only
`127.0.0.1`; it does not download weights or install an environment. It is a
separate process whose startup/shutdown remains the operator's responsibility,
not a cross-platform bundled embedding runtime.

In PDF settings select **Local Qwen3 embedding**. The built-in defaults target
`http://127.0.0.1:8001/v1/embeddings` and the revision above. `embeddingEngine: none`
is the default: ordinary use starts no model and performs no download. The
conversation model is not assumed to support embeddings. A third-party engine
uses the same typed registration contract; see [engine extensions](ENGINE_EXTENSIONS.md).

## Data flow and ownership

```mermaid
flowchart LR
  Tool["pdf_find_related"] --> Host["Authorized Host adapter"]
  Host --> Copy["Existing shared working copy"]
  Host --> Index["Retrieval service<br/>Page-local exact text chunks"]
  Index --> Lexical["BM25 postings"]
  Index --> Vectors["Typed embedding provider<br/>Document / query encodings"]
  Lexical --> Fuse["RRF + branch coverage protection"]
  Vectors --> Fuse
  Index <--> Cache["Bounded derived cache<br/>Not drafts or access grants"]
  Fuse --> Evidence["Re-read original ranges<br/>Existing evidence.refId"]
  Evidence --> Context["Read surrounding context"]
  Evidence --> Resolve["Existing native geometry resolver"]
  Resolve --> Draft["Undoable shared-draft annotation"]
  Resolve --> Navigate["Visible Reader navigation<br/>Existing multi-step history"]
```

`modules/retrieval` owns chunking, ranking and index jobs. `embedding` owns the
typed provider registry. Host adapters own DSH authorization, provider selection,
storage, model-facing search sessions and evidence signing. There is no second
document table or anchor store.

### Public tool continuation

Start `pdf_find_related` with `documentId`, `query` and its optional `terms`,
`mode`, `topK`, `fromPage` and `maxPages`. The response contains `searchId: "rel_…"`
and a boolean `hasMore`. While `hasMore` is true, call the same tool with only
`{"searchId":"rel_…"}`. Do not repeat the query, document or options. The public
tool no longer accepts `cursor` or returns `nextCursor`; Host keeps the original
request, source/engine constraints and internal continuation progress.

`building` and `incomplete` still report progress and coverage without globally
ranked candidates. Only `complete` returns rankings for the requested scope and
sets `hasMore: false`. Inspect `effectiveMode`, `fallbackReason` and `coverage`
before describing the result as semantic retrieval or complete text coverage.

The exact, case-sensitive `pdf_search` uses the same initial-call pattern, with
its optional `fromPage` and `offset`, then only `{"searchId":"txt_…"}` on that
same tool. Its results are paginated matches; `hasMore: false` means that search
has finished. It does not use related-index build statuses. Neither search ID is
a page-list cursor, and `pdf_bookmarks`, `pdf_locate` and `pdf_context` retain
their existing cursor contracts.

Search IDs are opaque, session-scoped and tool-scoped. Reset, TTL expiry or budget
eviction invalidates them; unknown or expired IDs require a new initial call.
Changing a query, scope or option also starts a new search. IDs do not grant file
access, and source/version validation still prevents mixed-version results.

Each chunk retains its one-based physical page, original UTF-16 start/end and
whole-page text digest. Normalization is confined to scoring. Boundaries prefer
paragraphs/lines, remain on one page and do not split Unicode surrogate pairs;
the default maximum is 1,200 UTF-16 units with a modest overlap. Smaller provider
input limits reduce chunk size. Text extraction order is preserved, including
its limitations on complex layouts.

Only returned candidates receive existing evidence references after their page
text has been re-read and compared. `annotationStatus: requires-geometry-check`
does not promise a writable target: annotation/navigation still invokes the
existing strict native glyph resolver, which may reject ambiguous layout or
missing geometry. OCR-derived candidates are not promoted to native coordinates.

## Budgets and lifecycle

- Index only after an explicit search; embedding is disabled by default.
- The default search scope is the whole document; `fromPage/maxPages` restrict
  the scope, not the amount processed per call. This intentionally changes the
  old `pdf_find_related` page-window meaning of `maxPages`.
- Process at most 20 pages and 4 embedding batches per indexing step, yielding
  between work units. The model continues with only `searchId` while `hasMore`
  is true; short public handles do not remove the internal bounded steps.
- Host retains query continuation state and validates scope, query, source and
  engine generation. Incomplete coverage produces progress, not a global
  best-match or no-answer claim.
- Runtime defaults cap indexes at 5,000 chunks each, 8 resident indexes, an
  estimated 64 MiB total index budget, 2 simultaneous build jobs and 8 admitted
  queries. Active indexes cannot be evicted mid-query; each build step retains
  its own document lease. These are
  admission limits, not a guarantee of total process RSS; larger scopes may need
  to be split explicitly.
- The separate `pdf_retrieval_<profile>` Storage Domain stores derived text and
  vectors with default limits of 64 MiB serialized data, 12,000 records and 7 days.
  Individual records are limited to 2 MiB. Cache loss/corruption can be rebuilt
  and must not damage drafts. The cache may contain document text; it is local
  plugin storage, not an encrypted vault or an authorization token.
- Reuse vectors by text/model identity after source revalidation; annotation-only
  edits do not rebuild the text index.
- A save can change PDF bytes. Page text is verified/re-extracted for the new
  source, while unchanged text may reuse vectors. Changes in weights, tokenizer,
  query instruction, dimensions or provider configuration change the model
  fingerprint; unloading/re-registering also fences the runtime generation.
- Closing a session or unloading the plugin cancels queued work and fences late
  results. Cancellation of an HTTP request does not imply a running external model
  computation has stopped immediately.

Native PDFium calls and active Metal kernels are not preempted halfway through;
their bounded operation retains its execution slot until it finishes. No claim
is made that all CPU/GPU usage ends as soon as a caller receives cancellation.

## Coverage and limits

The production indexing adapter deliberately requests native text with automatic
character-repair OCR disabled. Opening/searching a long book must not silently
launch hundreds of OCR jobs. Empty pages and undecodable characters appear in
coverage/warnings. Explicit OCR and page-image tools remain available separately,
but their output is not automatically ingested into this index.

Text around a formula or figure can retrieve its page; this does not mean the
formula, table or graph has been understood. Image-only content is reported as
not indexed. The synthetic complex-page cases record this missing coverage rather
than inventing images, layout evidence or OCR accuracy. No multimodal index,
reranker, semantic answer validator, cross-document search or automatic section
reconstruction is included. No-answer queries can still return ranked candidates;
the agent must read context and cannot infer that a result proves the answer.

Production ranking cooperatively yields and rechecks cancellation/source fences
after 64 BM25 build chunks, 1,024 lexical posting contributions or 32 vectors.
These wrappers share algorithms with the synchronous component benchmark; they
are not a dedicated ranking worker or an ANN index. Work within one unit remains
synchronous. Dense/long pages near the chunk budget still need representative
UI/CPU testing. The experiment has no latency SLA.

## Validation record

The records below were produced on 2026-10-25, Apple M5 Pro / 24 GiB RAM,
macOS arm64, Node `v26.7.0`, with the real local Qwen model above. No personal PDFs,
form values or remote embedding service were used.

The corpus in [`bench/retrieval-corpus.ts`](../bench/retrieval-corpus.ts) contains
28 passages and 23 queries: 21 with authored relevant passages and 2 no-answer
cases. Labels were written before inspecting rankings and were not changed after
the failure below. Corpus SHA-256:
`e0d8cbb09ce7b9d985e2739fb7fbe686e119c45c107d933b6593f4157e751fcb`.
It covers bilingual exact/paraphrase/cross-language queries, negation and repeated
passages. Because it helped diagnose and choose the fusion policy, this is a
development corpus, not an untouched held-out evaluation.

### Quality and the failed first fusion

| Method | Recall@5 | Top-1 hit rate | Cross-language Recall@5 (7 queries) |
| --- | ---: | ---: | ---: |
| Frozen old lexical scanner | 66.67% | 66.67% | 0% |
| BM25 | 66.67% | 66.67% | 0% |
| Qwen semantic only | 100% | 90.48% | 100% |
| Naive RRF, up to 30 per branch | 66.67% | 66.67% | 0% |
| RRF, shorten each branch to 10 | 76.19% | 66.67% | 28.57% |
| RRF, protect each branch's first hit | 95.24% | 66.67% | 85.71% |
| Current protected hybrid candidates | 100% | 66.67% | 100% |

With only 28 passages, a long semantic shortlist included nearly the whole
corpus. Weak lexical matches therefore received two RRF contributions and pushed
out correct cross-language passages present only in the semantic branch. Reducing
the shortlist helped but did not fix that structural failure.

The current policy protects the first semantic candidate, first lexical candidate
and second distinct semantic candidate when the requested result count permits;
remaining slots follow RRF (`k=60`). Selected candidates are still presented in
RRF order. At `topK: 1`, only the semantic leader can be protected. This is a
candidate-coverage safeguard, not a relevance probability or a claim of the best
general fusion algorithm. In this corpus it recovered the lost passages but did
not improve Top-1 ordering. A small perfect Recall@5 is not production accuracy.

Both no-answer queries still returned candidates in the current hybrid mode.
There is no calibrated abstention threshold. Three independent unit scenarios
test semantic-only leaders, lexical-only identifiers, duplicates and `topK`
edges separately from the development corpus.

### Component timing and cache reuse

Three repetitions produced 69 query observations per method. These few mixed
queries do not establish stable tail percentiles. First document embedding was
against an already running model; it excludes model loading/download.

| Measurement | Observed |
| --- | ---: |
| Encode 28 synthetic chunks, already-loaded model | 175.96 ms |
| Old lexical query p50 / p95 | 0.122 / 0.222 ms |
| BM25 query p50 / p95 | 0.018 / 0.045 ms |
| Semantic query p50 / p95, including fresh query embedding | 15.69 / 17.18 ms |
| Protected hybrid query p50 / p95, shared work counted once | 15.72 / 17.24 ms |
| 100-page / 100-chunk cached-vector hybrid ranking p95 | 0.285 ms |
| 1,000-page / 1,000-chunk cached-vector hybrid ranking p95 | 2.532 ms |

The scale corpus repeats the 28 small passages, uses about 158,780 text characters
at 1,000 pages and reuses already computed document/query vectors. Those timings
exclude embedding, PDF extraction and disk IO; they do not represent an arbitrary
1,000-page textbook. The theoretical 1,000 × 1,024 × Float32 vector payload is
4,096,000 bytes, but the benchmark reuses arrays and production uses JavaScript
numbers, so this is not a measured cache-memory bound.

The same runner also calls the actual retrieval service, with a synthetic page
provider and a structured-clone in-memory KV adapter:

| Service state | Duration | Page reads | Document embedding inputs | Tool-style calls |
| --- | ---: | ---: | ---: | ---: |
| Empty derived cache | 205.05 ms | 28 | 27 unique texts | 2 |
| Warm same service | 27.12 ms | 0 | 0 | 1 |
| New service, restored derived cache | 54.88 ms | 0 | 0 | 2 |

Each query still encodes the query once. Duplicate page text shares one document
embedding. This validates reuse and continuation, not on-disk performance or the
full Desktop lifecycle.

The JSON report includes Node process CPU time, CPU percentage, RSS/heap snapshots
and coarse 10 ms event-loop timer lag. External MLX/GPU usage is excluded. A scale
stage runs 69 queries synchronously, so its lag includes the entire artificial
query series and must not be quoted as a single Host-query stall. These metrics
do not measure the whole app's memory or rendering performance.

### Real PDFium and local embedding integration

[`bench/retrieval-integration.ts`](../bench/retrieval-integration.ts) generates a
six-page PDF in memory and uses the real PDFium helper and local MLX server. Both
the source and built embedding SDK registry passed the same integration checks:
a Chinese question finds its English evidence, the exact reference creates a
highlight in the shared draft, a later UI-owner open sees that draft, and the
Host navigation contract receives its acknowledgement. No original-file writes
are performed.

| Built-SDK run | Duration | Document embedding inputs |
| --- | ---: | ---: |
| Empty retrieval cache, model already running | 180.32 ms | 6 |
| Warm query | 19.85 ms | 0 |
| Annotate the exact evidence reference | 3.12 ms | 0 |
| Query after draft annotation | 18.82 ms | 0 |
| New runtime/logical document, restored cache records | 337.45 ms | 0 |

The source-SDK cold/warm measurements were 185.09 / 20.91 ms. They are individual
observations, not a comparison of SDK speed. Restoring 12 cache records (132,780
serialized bytes) avoids document embedding but still starts a new native helper;
it is not expected to beat a warm same-runtime query. Built-SDK Node RSS snapshots
ranged from 198.1 to 213.5 MB and exclude the PDFium child and MLX process.

Cache persistence here is a JSON round-trip in memory, not a measurement of the
DSH storage driver. UI takeover and navigation are exercised at their Host
contracts, not by mounting a browser or testing viewport scrolling/back history.
These six synthetic text pages validate the integration path, not broad retrieval
quality, complex layouts or large-document performance.

### Reproduce

Lexical-only mode requires no model:

```sh
npm run bench:retrieval -- --repeats 3 --out /tmp/retrieval-lexical.json
```

After starting the cached local model:

```sh
npm run bench:retrieval -- \
  --embedding-endpoint http://127.0.0.1:8001/v1/embeddings \
  --model-revision b8d7100604f51da6d14eab4dd1805f596fa1ce3f \
  --repeats 3 --out /tmp/retrieval-qwen.json
```

After building the plugin and native helper, the separate integration runner is:

```sh
npm run bench:retrieval:integration -- \
  --endpoint http://127.0.0.1:8001/v1/embeddings \
  --sdk dist --out /tmp/retrieval-integration.json
```

The runner writes structured JSON to stdout and optionally creates an output file
exclusively; choose a new filename for each run. An explicitly requested but
unavailable backend fails the run rather than substituting fake vectors or
reporting a lexical result as semantic. The original failed RRF policy is still
evaluated alongside the current policy. `bench/legacy-related-text.ts` is the
frozen old baseline and is not shipped as a second production search path.

Local raw records from this session are
`/private/tmp/pdf-retrieval-qwen-benchmark-20261025.json` (initial failed fusion),
`/private/tmp/pdf-retrieval-verified-performance-20261025.json` (final component/cache
run), `/private/tmp/pdf-retrieval-lexical-benchmark-20261025.json` (model-free
run), and `/private/tmp/pdf-retrieval-verified-integration-20261025.json` (final
built-SDK/native/local model integration). Final timing tables above use these
verified runs, executed serially after repository tests finished. Earlier
source-SDK integration remains at `/private/tmp/pdf-retrieval-integration-source.json`.
They are temporary machine-local artifacts, not repository fixtures.

The original experiment's final `npm run check` passed source, test and benchmark type checks, the production
build and 1,256 Node tests with zero failures/skips (including the OCR browser
worker test using installed Chrome). The independent browser replay suite passed
37/37. Published SDK imports, declaration paths and package inclusion were checked.
Runtime tests cover continuation/source changes, cache bounds and restoration,
shared-job leases, query admission, cancellation/unload, real Cordis contributor
registration, current semantic capability reporting and the exact evidence-to-draft
chain. These gates do not establish broad semantic accuracy or real Desktop UX
acceptance; the development-corpus and environment limitations above still apply.
