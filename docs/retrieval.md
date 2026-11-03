# PDF retrieval

This document describes the current single-document retrieval behavior. For the
engine registration contract and all engine settings, see
[Engine extensions](engine-extensions.md). For reproducible commands, see
[Benchmark protocols](../bench/README.md); frozen measurements are linked at
the end.

## Configure semantic retrieval

`embeddingEngine: none` is the default. It starts no embedding model and does not
download weights. `pdf_keyword_search` works without an embedding provider;
`pdf_semantic_search` requires a configured, available provider. The conversation
model is not assumed to provide embeddings. Check `pdf_status` and its
`capabilities.semanticSearch` before invoking semantic search.

The built-in **Embedding service** has the stable engine ID
`local-qwen3-embedding`. It accepts either a loopback
HTTP service or an HTTPS service with an OpenAI-compatible `/embeddings` endpoint
and sibling `/models` endpoint. Select it in PDF settings and set its `endpoint`,
`model`, `dimensions`, `maxBatchSize`, `maxInputCharacters` and optional
`queryInstruction`. `queryInstruction` is empty by default. If authentication is
needed, set `apiKeyRef` to a DSH Host credential reference, not to a raw API key.
An unavailable or incompatible service is reported explicitly; semantic search
does not silently fall back to lexical ranking. Other embedding providers may
register through the same typed interface.

For a local example, [`scripts/local-embedding-server.py`](../scripts/local-embedding-server.py)
serves cached `mlx-community/Qwen3-Embedding-0.6B-8bit` weights on
`http://127.0.0.1:8001/v1/embeddings`. It needs a separately installed Python
environment with MLX embedding, FastAPI and Uvicorn; the plugin does not start
the server or install the model. Qwen3's query instruction for the included
benchmark is:

```text
Given a search query, retrieve relevant passages from the document that answer the query
```

Use the instruction required by the selected model; do not copy the Qwen3 value
to unrelated services. The adapter learns a reported model revision and uses it
in cache identity. If a service silently changes weights or tokenizer without
reporting a revision, select a distinct engine identity or clear the profile's
index caches before relying on old results.

### Per-document content choices

Search → **Current PDF index** saves two switches per PDF path:

- **Text recognition (OCR)** (`indexScanPages`, default `true`) recognizes
  scanned pages or damaged native text using the globally selected OCR engine.
  The built-in OCR default is `local-tesseract`.
- **Image descriptions** (`indexImageDescriptions`, default `false`) asks the
  globally selected image-understanding engine for searchable page descriptions.
  This can send page images to the configured provider and incur model cost.

Native PDF text is always included. The switches do not enable embeddings by
themselves. Global engine selections and connections belong to PDF settings;
these two document preferences determine which extra content is indexed. New
documents inherit the current defaults. Changing settings saves a *pending*
plan; **Update index** applies it only after a successful build, leaving the
previous active index usable in the meantime. Globally selecting `none` for
embeddings disables semantic indexing immediately without deleting stored
content or document preferences.

## Index, storage and recovery

Opening a PDF in the Reader or with `pdf_open` can schedule background
preparation when its active plan enables an available embedding provider. The
open call does not wait for indexing. An early search may continue the remaining
work. Background preparation and foreground search share page content, vectors
and build jobs; authorization is still checked for each Session. An index is
derived data, never an access grant or a second PDF working copy.

The durable index is SQLite under
`<DSH_HOME>/storages/dsh-plugin-pdf/<profile>/<namespace-hash>/retrieval-v1`.
It stores immutable page content, provenance and vectors; checkpoints point to
those records. Source layers (native text, OCR, descriptions) and compatible
document vectors can be reused independently. A canonical path and an
annotation-independent page-content identity let annotation, comment and
outline-only edits reuse indexed content. Page programs, resources, geometry or
order changes invalidate the affected content. Raw file/source versions still
fence evidence, authorization and active searches. Unverifiable page structure
uses the raw file digest conservatively; the identity check does not prove
arbitrary PDF graphics-program equivalence.

Successful page checkpoints survive cache eviction, cancellation, failure and
Host restart. **Resume indexing** / **Retry indexing** continues the interrupted
task's *original* source and plan, repairing missing work. If the source or plan
has changed, explicitly start **Update index** instead. **Rebuild index** builds
the current PDF's structure again while reusing validated extraction and vector
artifacts. PDF settings → **Clear all index caches** is a separate profile-wide
operation that discards the derived results and active search continuations;
it does not delete PDF files, drafts or saved document policies. A reset drains
background work before eligible open documents resume. Interrupted external
model calls may finish after cancellation, and output not yet durably written
may need recomputation.

Imported cache records must pass source, geometry, producer and scope checks.
An unknown model binding or unverifiable source is not guessed into a cache hit.
Index records may contain document text; this local storage is not an encrypted vault.

The index hot cache is capped at 8 MiB, the SQLite page cache at another 8 MiB,
and mmap is disabled. These are cache budgets, **not** measured process RSS or
total disk limits. A single record is capped at 64 MiB. Damaged records and disk
exhaustion are explicit storage failures, not silent empty search results.

## Search and evidence

Start `pdf_semantic_search` with `documentId`, `query` and optional `terms`,
`mode`, `topK`, `fromPage` and `maxPages`. It returns an opaque `rel_…` `searchId`
and `hasMore`. While `hasMore` is true, continue the **same tool** with only
`{"searchId":"rel_…"}`; Host retains the original request and indexing progress.
`building` reports progress, not global rankings. `incomplete` can report
partial candidates and failed pages; only `complete` covers the requested
scope. Inspect `effectiveMode`, `coverage` and quality warnings before claiming
that a document was fully searched.

`pdf_keyword_search` is separate literal matching. Its initial call uses
`documentId`, `query` and optional page/matching options; later calls use only
its own `txt_…` `searchId`. Search IDs are Session- and tool-scoped, expire, and
never grant file access. An invalid, expired or source-stale ID requires a new
initial call. An empty *partial* result is not evidence of absence.

The retrieval index keeps original UTF-16 offsets and page digests. Text is
normalized only for scoring. BM25 and cosine candidates are combined with
protected reciprocal-rank fusion; ranking is a lead, not a calibrated answer or
relevance probability. Only returned candidates receive source-bound evidence
references after their source page is re-read. Read surrounding text with
`pdf_evidence_read` before answering or annotating. A reference covers its
entire stored quote; for native text, pass a unique exact `quote` to narrow a
subrange. Native glyph geometry is revalidated before precise annotation or
navigation. OCR text and generated image descriptions have page/approximate
region provenance, not native character coordinates, and cannot be treated as
exact PDF quotations or precise native-text annotation targets.

## Resource and quality limits

Production uses at most four active plan runtimes. Each allows two resident
index summaries, 64 MiB of accounted working metadata/current-page data, two
build jobs and eight admitted queries; each index is capped at 20,000 chunks.
An indexing step processes at most 20 pages and four embedding batches before
yielding. Background preparation tracks at most 64 open PDFs and advances one
document at a time. Admission/cache accounting is not a process-memory bound;
native PDFium and external model operations are not preempted mid-call.

Recognition and image descriptions improve coverage but may contain errors.
With those sources disabled, image-only content remains uncovered. Even with
them enabled, there is no raw-image vector index, reranker, calibrated no-answer
threshold, cross-document search or guarantee of correct formula/table/chart
interpretation. A no-answer query may still return ranked candidates.

Failed/cancelled index tasks retain progress and offer **Copy diagnostics** and
**Open log directory**. Logs are stored under
`<DSH_HOME>/logs/dsh-plugin-pdf/<profile>/indexing-YYYY-MM-DD.jsonl`; they record
bounded timings, phases, counts and error codes, not PDF text, prompts, paths,
credentials or raw provider responses.

## Measurement evidence

- [Frozen indexing benchmark](benchmarks/indexing-20261102/README.md): local
  SQLite/checkpoint cost, reuse and restart recovery with fake vectors. It does
  not measure PDFium, OCR, inference, network or real-user latency.
- [`bench/retrieval.ts`](../bench/retrieval.ts) and
  [`bench/retrieval-integration.ts`](../bench/retrieval-integration.ts): synthetic
  ranking and real-PDFium/local-model integration runners. Their small authored
  corpus is a development fixture, not held-out retrieval accuracy evidence.
- [Performance summary](../performance.md): other frozen component measurements
  and their limitations. None establish a full DSH Desktop latency SLA.
