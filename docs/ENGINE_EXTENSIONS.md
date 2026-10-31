# Engine extensions

Image processing has two typed Host services: OCR (image → recognized text, with optional geometry) and image understanding (image + prompt → generated text). Translation and embedding remain separate services. None is a Reader component. Contributors inject the service they extend and own the registration disposer through `ctx.effect()`. They do not need a Client entry or changes to PDF settings. Plugin code is trusted executable code, not a sandbox boundary. Embedding is experimental and disabled by default.

## Independent plugin package

A buildable example lives in [`examples/http-engines`](../examples/http-engines). Its actual backends are exercised by [`tests/examples/engine-extensions.test.ts`](../tests/examples/engine-extensions.test.ts), including HTTP mapping, cancellation, configuration and live catalog/unload behavior. This checkout changes the image SDK contract; use a package build containing `understand()` rather than an older release.

Write an extension as its own package, for example `@example/dsh-pdf-engines`.
The `@dylanl1/dsh-plugin-pdf/...` imports below refer to the PDF bundle's public
SDK. These are subpaths of the main npm package, not a separate SDK package or
local-source aliases. Import the contracts from that package and keep your
backend implementation in your own package. Do not import another checkout's
`src/` or `dist/types/` files.

The extension's manifest declares the host-provided packages as peers:

```json
{
  "name": "@example/dsh-pdf-engines",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist"],
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.5",
    "@dylanl1/dsh-plugin-pdf": "^0.1.2"
  }
}
```

For development, also install these peers as dev dependencies so TypeScript can
resolve the SDK:

```sh
npm install --save-dev @dylanl1/dsh-plugin-pdf@^0.1.2 @deepseek-ai/cordis@4.0.5
```

The main PDF package obtains the matching prebuilt native dependency for its
platform; extension authors do not need to build PDFium. A type-only development
environment can use npm's `--omit=optional` option to skip those native files,
but the running PDF bundle still needs its platform native package.

Build your Host entry to `dist/index.js` and load the extension in the same Host
profile as the PDF bundle. `peerDependencies` describes package compatibility;
the entry's `inject` declaration controls when Cordis starts it. Register with the
existing service rather than creating or bundling a second service instance.
The `import type` declarations below are erased from JavaScript and do not mount
the PDF bundle's plugins. `./backend.js` is your extension's own implementation.

| Service | Import contracts from the PDF SDK | Execution contract |
| --- | --- | --- |
| `ocr` | `@dylanl1/dsh-plugin-pdf/ocr-host` | `recognize(request, configuration)` returns validated OCR text and optional image-pixel geometry |
| `imageUnderstanding` | `@dylanl1/dsh-plugin-pdf/image-host` | `understand(request, configuration)` returns generated text and optional model/limitations |
| `pdfTranslation` | `@dylanl1/dsh-plugin-pdf/translation` | `translate(request, configuration)` returns a translation, optional lexical details and optional source interpretation |
| `pdfEmbedding` | `@dylanl1/dsh-plugin-pdf/embedding` | `describe(configuration)` identifies the encoding; `embed(request, configuration)` returns one finite nonzero vector per input |

Common descriptors, bindings and configuration types are exported from
`@dylanl1/dsh-plugin-pdf/engines`. Use stable namespaced IDs such as
`example.http-ocr`. Each backend has a required `descriptor` with `id`, `name`,
`version`, `execution` and optional `configurationFields`. The typed service
normalizes its capability (`ocr-text` or `image-description`); an image backend
has no additional `id`, `kind`, OCR dependency or interaction/indexing mode.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { HostOcrBackend } from '@dylanl1/dsh-plugin-pdf/ocr-host'
import { backend } from './backend.js'

export const inject = ['ocr']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.ocr.register(backend satisfies HostOcrBackend))
}
```

## Configuration and selection

Settings save automatically. Index engine choices and the two content switches
are defaults for newly opened documents. Each PDF has its own policy under
**Search → Current PDF index**; selecting **Use current defaults** explicitly
copies the latest defaults. Changes save without starting model work: the user
starts **Update index** to build a replacement while the current index remains
usable if its engine is still available. Cancellation or failure retains the
active plan. Selecting `none` for that PDF takes effect immediately and retains
cached content.

PDF settings select `ocrEngine`, `imageEngine`, `translationEngine` and
`embeddingEngine`. `engineConfigurations` retains each engine's configuration
under its kind and ID (`ocr`, `image`, `translation`, `embedding`). Switching
engines does not delete other engines' saved configuration. Other Host consumers
may pass an explicit `binding` without changing the Reader's choice.

**Text recognition indexing** (`indexScanPages`, default `true`) uses the selected
OCR engine for missing or damaged native text. **Visual description indexing**
(`indexImageDescriptions`, default `false`) uses the selected image-understanding
engine with the indexing prompt and embeds its generated text, not raw pixels.
Both switches may be on. Each document selects its bindings from the same OCR
and image-understanding directories; there is no extra visual-description service
or registry. Neither switch enables the default-disabled embedding engine.
Descriptions add model calls, latency and possible fees.

```yaml
ocrEngine: example.http-ocr
imageEngine: example.http-vision
indexScanPages: true
indexImageDescriptions: true
engineConfigurations:
  ocr:
    example.http-ocr:
      endpoint: http://127.0.0.1:9000/ocr
  image:
    example.http-vision:
      endpoint: http://127.0.0.1:9000/vision
```

Configuration fields can be `string`, `number`, `boolean` or `secret-reference`,
with a key, label and optional `required`. Settings render contributor fields; the
built-in DSH model route uses the selector below. The Host validates declared
keys/types before execution. A secret reference is an opaque name, never
an API key. Contributors own Host-side credential creation and resolution.

The built-in OCR choices are the current-session model (`session-llm`) and local
Tesseract (`local-tesseract`). Image understanding has one built-in DSH adapter
(`dsh-vision`). In PDF settings, **Follow current session** is the default.
Choose **Specify model** to load DSH's provider-grouped visual-model list; select
a model and, when advertised, its reasoning effort. Provider/model IDs are not
manual input fields. This choice configures PDF image processing without changing
the conversation's model. Returning to Follow clears the model and effort overrides.

The saved backend configuration still uses `provider`, `model` and optional
`reasoningEffort`; an absent route follows the conversation. Existing explicit
routes remain visible, including an unavailable saved choice after a catalog
change or load failure. The Host rechecks the exact model's image-input support
before execution. The adapter always performs inference and returns text; it is
neither an OCR fallback nor an image-attachment transport.

Explanation remains a conversation feature: a visual conversation receives the
verified image directly, without an extra vision request. A text-only conversation
can receive text produced by the configured image-understanding engine. An
unavailable engine reports a reason instead of silently invoking OCR or another
provider. Explicit OCR calls remain available independently. The final explanation
always comes from the conversation model.

Legacy session-model image selections migrate to `dsh-vision`. Legacy auxiliary
selections migrate only when an explicit Provider/Model route can be preserved;
a route formerly held only in an old Host patch remains unavailable until the
user explicitly selects a new engine. Removed OCR image-bridge selections also
remain unavailable rather than silently switching to a remote visual model.
These placeholders do not register or execute the removed backends.

## Execution contracts

OCR implements `recognize(request, configuration)`. Its input is an encoded image,
image dimensions, languages, session identity and cancellation signal. Return a
validated `OcrOutput`: text, optional block/line/word geometry (input-image pixels),
confidence when available, completion/coverage and warnings. Empty successful
transcription is valid; do not invent word boxes or confidence scores.

Image understanding implements this one operation:

```ts
import type { ImageUnderstandingBackend } from '@dylanl1/dsh-plugin-pdf/image-host'

const backend: ImageUnderstandingBackend = {
  descriptor: {
    id: 'example.local-vision', name: 'Local vision', version: '1', execution: 'local',
  },
  async availability() { return { available: true } },
  async understand({ image, prompt, signal }) {
    return { text: await describeImage(image, prompt, signal) }
  },
}
```

`understand` receives `{sessionId, image, prompt, signal, binding?}`; `image` contains
PNG bytes, media type, width and height. It returns `{text, model?, limitations?}`.
The service returns `{text, source: {backendId, backendVersion, model?}, limitations?}`
to consumers. Questions, visual index descriptions and other image tasks differ
in their prompts, not in their backend interfaces. Use the example's actual
implementation in place of the illustrative `describeImage` function above.

## OCR and image content identity

Semantic indexing stores a validated `PageContent` snapshot with separate
native-text, OCR-text and image-description representations. Each retains its
producer identity, exact output-text digest, optional geometry and clean
rendered-input digest. OCR positions are converted from input-image pixels to
PDF coordinates when supplied. Native UTF-16 offsets are never replaced by OCR
or description offsets. The initial visual block covers the whole page; individual
figure/table/formula detection is not implemented. Derived hits have approximate
page/region references and cannot certify native text annotations.

If optional OCR or description fails after usable text is available, that text
stays indexed but coverage remains `incomplete` and includes `failedPages`. No
continuation can retry a completed failed enrichment; explicitly rebuild the
document. Failed content snapshots are not persisted. A successful empty OCR
result means no text was recognized, not a failed page.

Both backend contracts may implement optional asynchronous
`cacheIdentity(sessionId, signal, configuration)`. Return a stable nonempty string
only when it identifies the actual model, weights/revision, routing and all other
output-affecting behavior across restarts. The Host combines it with descriptor
and canonical configuration. An engine ID or endpoint alone does not attest a
mutable model. Without an identity (or with `{identity, reusable:false}`), derived
caches stay isolated by session and registration lifetime. Stable identities
permit reuse without bypassing source, rendered-input, configuration, availability
or authorization checks. Registration generation fences late output independently.
Forward `AbortSignal` and avoid unbounded identity probes.

## Embedding provider contract

The Reader registers `none` and `local-qwen3-embedding` through `EmbeddingRegistry`.
The latter displays as **Embedding service**; its stable engine ID remains
`local-qwen3-embedding` for existing configurations. Its neutral
`execution: 'service'` descriptor covers both local and remote endpoints; no
local/remote engine switch is needed. Qwen3 is its default configuration example.
The default selection is `none`; it starts no model and performs no download.
A chat/vision model is not automatically an embedding provider. Third-party
engines use the same registry and settings catalog:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { EmbeddingEngine } from '@dylanl1/dsh-plugin-pdf/embedding'
import { engine } from './backend.js'

export const inject = ['pdfEmbedding']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.pdfEmbedding.register(engine satisfies EmbeddingEngine))
}
```

An engine supplies `descriptor`, synchronous side-effect-free `describe(config)`,
optional `availability(config, signal)`, and `embed(request, config)`. The request
contains `texts`, `purpose: 'query' | 'document'`, `signal` and `timeoutMs`.
`EmbeddingEngineOutput` accepts either vectors in input order or
`{ vectors, model: EmbeddingModel }`. The latter lets a provider report the exact
model identity verified for this operation; the registry requires it to match the
provider's current description. Traditional vector-array providers remain valid,
but an identity change during their request is rejected. The registry checks
count, dimensions, finite numbers and nonzero norm, then L2-normalizes vectors.
Reject oversized inputs instead of silently
truncating. Forward cancellation to network/process work and release any owned
runtime through the contributor's Fiber lifecycle.

`EmbeddingModel` reports `engineId/engineVersion`, `model/modelRevision`,
`dimensions`, `maxBatchSize`, `maxInputCharacters`, `encoding` and `fingerprint`.
These are provider-owned internal encoding identities, not required user settings.
The character limit counts UTF-16 units; the provider must additionally enforce
its real tokenizer limit. The fingerprint must change with weights, tokenizer,
query/document instructions or other encoding-affecting configuration. It keys
rebuildable vectors, not document permissions. Registry `generation(binding)` is
separate: it fences a registration lifetime so unloading/replacing an engine
invalidates in-flight work even when the encoding fingerprint is unchanged.

Providers may also return `documentFingerprint`, an optional nonempty string of
at most 512 characters identifying only document-vector encoding. It must change
with document weights, tokenizer, dimensions or document instructions; query-only
instructions and transport batch sizes can leave it unchanged. Consumers namespace
it by engine ID. Without it, retrieval conservatively keeps the full binding in
the vector-cache key. The complete fingerprint, configuration and registration
generation still fence requests and queries, even when document vectors are reused.

Consumers call `registry.embed(request, binding)` and receive `{ vectors, model }`;
`list/subscribe` drive the dynamic settings catalog. Selection is captured per
request. Removing a provider aborts its active requests; retrieval also rejects
late results from the old generation. Settings retain a missing selection while the catalog removes the unloaded provider.
The `pdf_semantic_search` tool requires a configured, available embedding engine
and reports unavailable engines explicitly. It does not expose the internal
retriever's automatic lexical fallback; literal matching uses `pdf_keyword_search`.

When a document's active policy enables an available embedding engine, opening
its shared working copy from either the Reader or `pdf_open` schedules background
preparation. Providers
receive the same `purpose: 'document'` requests used by search; no new provider
method, synthetic query or query vector is involved. Before embedding, the shared
page-content pipeline can invoke selected-engine OCR for scanned/damaged pages
and optional selected-engine whole-page descriptions using the settings above. Preparation
shares indexes and in-flight build steps with foreground searches, including
other authorized Sessions in the same Host instance with matching source bytes,
page range and encoding configuration. Shared identity includes the source
digest, page count, extraction/preprocessing identities, retrieval
versions, scope, embedding fingerprint and registration generation; it excludes
Session-local document IDs, paths and `contentVersion`. Permissions, drafts,
queries, continuation handles, results and evidence references remain scoped to
each Session. Every access is authorized independently: a shared index is not an
access grant. Preparation does not delay opening, but an early search can still
need the remaining indexing work.
Remote services can receive page images and extracted/derived document text when
preparation starts, before any search query. Missing stable OCR/image identities
restrict sharing to the same Session and registration lifetime.

The Host runs at most one background document task and tracks up to 64 open
documents; excess documents retain on-demand search. Only actual UI/model
ownership counts as open, not an indexing lease. Closing the last owner in one
Session cancels that Session's preparation; it does not stop a build still used
by another authorized subscriber. Shared build work aborts when no subscribers
remain. Disabling indexing or applying an updated plan invalidates obsolete work;
editing defaults or pending choices does not switch the active plan. Provider
unload aborts affected requests without choosing a fallback engine.
Source changes can queue a fresh preparation; unchanged annotation edits do not.
Ready indexes remain subject to the shared LRU/memory budget, not permanent disk
storage. Failures do not retry indefinitely in the background.

The Reader's **Update index** starts, resumes or retries the current open PDF and
applies pending choices when embedding is enabled. It reuses caches; only an
unchanged, ready plan is a no-op. **Recompute entire index** forces fresh page
processing and document embeddings for the selected document without clearing
other documents' caches. **Clear all index caches** in PDF settings is the separate
profile-wide reset. Manual cancellation stays stopped for the same active
source/plan during that open lifecycle. A manual start, source or applied-plan
change, or close/reopen can schedule preparation again.

The existing task entry reports filenames, extracted/total pages and
embedded/total chunks for all open PDFs in the current resource Session, with
cancel/retry and persistent green **Index ready** records until Host removes the
closed PDF's task. Other short-lived save notices keep their existing timers. The
authenticated `pdf.indexing` RPC provides `status`, `start` and `cancel`, filters ownership by
Session and uses revision-based long polling for updates. It is a UI control
surface, not a model tool or an additional embedding-provider interface.

The included **Embedding service** adapter accepts a loopback HTTP endpoint or
an HTTPS endpoint ending in `/embeddings`. It sends OpenAI-compatible embedding
requests and checks availability through the sibling `/models` endpoint. Standard
model lists and indexed float-vector responses are sufficient; custom embedding
metadata and `model_revision` are optional. When supplied, metadata is checked for
the selected model, dimensions, limits and encoding, and must not report
truncation. The adapter learns `/models`' `embedding.revision` internally and
includes it in the fingerprint, so a reported version change separates the old
index automatically. The `/models` and embedding-response revisions must also
agree within an operation. Users do not configure a revision. This protocol
adapter does not cover every provider API.

Configure `model`, `dimensions` and input/batch limits for the selected service.
The adapter derives its cache identity internally from the endpoint, model,
dimensions, encoding configuration and any learned service revision. The removed `modelRevision` setting is
ignored when reading old configurations. The Qwen3 launcher in
[the experiment](RETRIEVAL_EXPERIMENT.md) remains the default
configuration example. `queryInstruction` defaults to an empty string for every
model. Configure it explicitly when the model requires a retrieval instruction;
clearing the field disables the instruction.

**Clear all index caches** in PDF settings invalidates this profile's in-memory
indexes, active searches and continuation state, and clears its persisted retrieval cache.
It first suspends and drains background preparation, then resumes it for still-open
documents after a successful reset when their active policy enables embedding.
Other documents rebuild on their next open or search. Pending choices still
require **Update index**; clearing caches does not apply them. It does not modify
PDF files, drafts, annotations or saved document policies. Use it when a service
replaces the weights or tokenizer behind an unchanged model name without reporting a new revision;
the standard protocol cannot detect such a replacement reliably. Rebuilding also prevents cancelled, older work from
repopulating the cleared cache.

Optional `apiKeyRef` is a DSH credential reference, resolved in Host through
`credentials.resolve()` and sent as Bearer authentication. Store the API key in
DSH credentials, never in `engineConfigurations` or the Client. Services without
authentication omit the reference. Extensions requiring other protocols or
authentication still register their own engine and own their credential
integration.

## Translation source recovery

The built-in model chooses whether a readable selection is a word, phrase or
sentence; word count no longer forces dictionary mode. Ordinary sentence
fragments may be translated directly. The model may correct extraction errors
or complete clipped text using the bounded adjacent context. Inferred completions
must remain distinguishable from the original selection; an engine must not
silently invent missing names, quantities or facts.

Translation extensions can optionally return this metadata alongside the existing
`text`, `status`, `warnings` and lexical `detail`:

```ts
interpretation: {
  text: 'calculate',
  kind: 'correction', // 'correction' | 'completion'
  certainty: 'confident', // 'confident' | 'tentative'
  explanation: 'Corrected a character recognized incorrectly.',
}
```

`interpretation.text` is the source used for the returned translation or lexical
entry; `request.text` remains the exact selection. Omit `interpretation` when no
source change was needed. The plugin does not compare this text with the selection
or make a second judgment about its meaning. The text may contain at most 8192
UTF-16 units; the explanation is limited to 500. Both count
toward the configured output budget, and interpreted text also respects the input
budget. Only complete outputs may carry recovery metadata. Unknown fields and
invalid enum values are rejected at registry and authenticated wire boundaries.
Engines that omit the metadata retain their existing output contract.

The Reader shows the original selection separately from the recovered source,
labels tentative results as a model inference, and uses the recovered text for
the lexical heading. `confident` is the engine's assessment, not a verified
probability. Recovery never edits the PDF, changes a selection or appends to
conversation history. There is no `recognized` gate: the built-in model returns
`kind` and its translation or lexical explanation directly. If meaning remains
uncertain, it explains that uncertainty in its displayed response. The plugin
validates response structure, limits and request lifetime, not translatability.
Single words and phrases may both carry model-provided pronunciation.

## Directory and lifecycle

- Each typed service owns its implementation directory and exposes `list()` / `subscribe()`. `pdfCapabilities` reports the service's profile-default capability and returns that same service; it is not a second engine-selection store. PDF use cases validate their explicit feature bindings through the typed services, without changing another consumer's default.
- `EngineCatalog` observes those sources. `pdf.engines` publishes descriptor-only snapshots over the existing authenticated connection, using a revision-fenced long poll. It works outside a resource session; it does not return credentials, field values or implementation functions.
- The Client reconciles translation proxies by descriptor, so unrelated registrations do not cancel active translations. Settings and capability checks refresh when catalog/settings change. Session-specific availability is checked in Host at use time, not inferred from installation.
- Removing an engine cancels its active tasks and availability probes. Late output is discarded. Registrations are identity fenced: an old disposer cannot remove a replacement with the same ID. Implementations must forward `AbortSignal` to their own network/process I/O and release resources when their Fiber unloads.
- A missing selection stays selected and displays as unavailable. No silent local/remote fallback occurs. Disconnects retain the last directory until reconnection; they are not interpreted as provider removal.
- Per-request configuration is captured before asynchronous work. OCR/image consumers can use independent bindings; Host translations use request-scoped instances rather than mutating one global selection.

Automatic repair of the Reader's selectable character layer deliberately remains a separate, fixed local path requiring positioned words. Semantic indexing's OCR option independently uses the selected OCR engine for missing/damaged native text; it does not replace that Reader layer or rewrite the PDF. Engine extensibility does not change source authorization, evidence validation, draft ownership or save approval.
