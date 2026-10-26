# Engine extensions

OCR, image understanding, translation and embedding are Host services, not Reader components. Contributors inject the service they extend and own the registration disposer through `ctx.effect()`. They do not need a Client entry or changes to PDF settings. Plugin code is trusted executable code, not a sandbox boundary. Embedding is experimental and disabled by default.

## Independent plugin package

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
| `imageUnderstanding` | `@dylanl1/dsh-plugin-pdf/image-host` | `prepare(request, configuration)` returns a direct-image route or derived text with provenance |
| `pdfTranslation` | `@dylanl1/dsh-plugin-pdf/translation` | `translate(request, configuration)` returns a translation and optional lexical details |
| `pdfEmbedding` | `@dylanl1/dsh-plugin-pdf/embedding` | `describe(configuration)` identifies the encoding; `embed(request, configuration)` returns one finite nonzero vector per input |

Common descriptors, bindings and configuration types are exported from `@dylanl1/dsh-plugin-pdf/engines`. Use stable, namespaced IDs such as `example.local-ocr`. A descriptor includes `id`, `name`, `version`, `execution` and optional `configurationFields`. Image backends also declare `id` and `kind`; their descriptor must use the same ID. Legacy image backends without descriptors receive an ID-based display name.

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

The Reader config provides `ocrEngine`, `imageEngine`, `translationEngine`, `embeddingEngine` and `engineConfigurations`. Configuration is retained independently for each kind/engine ID (`ocr`, `image`, `translation`, `embedding`); switching engines does not delete the previous configuration. Each feature binding acts as its own instance. Other Host consumers may pass a different `binding` to OCR/image/embedding requests or an explicit instance to `TranslationRegistry.translate()` without changing the Reader's choice.

```yaml
ocrEngine: example.local-ocr
imageEngine: ocr-text
translationEngine: dsh-model
engineConfigurations:
  ocr:
    example.local-ocr:
      language: eng
```

Declare configuration fields as `string`, `number`, `boolean` or `secret-reference`, with a key, label and optional `required`. The settings card renders these fields and the Host validates declared keys and types before execution. Store actual credentials through the contributor's Host credential integration; a `secret-reference` field contains only an opaque reference, never an API key. The PDF plugin does not create or resolve third-party credentials itself.

Defaults (`session-llm`, `session-vision`, `ocr-text`, `auxiliary-vision`, `dsh-model`) register through the same public interfaces. Auxiliary vision accepts optional `provider`, `model` and `reasoningEffort` fields; omitted fields retain the existing Host profile route. Explanation answers still use the conversation model. The OCR-text route uses the selected OCR binding and does not claim to understand figures.

## Embedding provider contract

The Reader registers `none` and `local-qwen3-embedding` through `EmbeddingRegistry`.
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
contains `texts`, `purpose: 'query' | 'document'`, `signal` and `timeoutMs`. Return
vectors in input order; the registry checks count, dimensions, finite numbers and
nonzero norm, then L2-normalizes them. Reject oversized inputs instead of silently
truncating. Forward cancellation to network/process work and release any owned
runtime through the contributor's Fiber lifecycle.

`EmbeddingModel` reports `engineId/engineVersion`, `model/modelRevision`,
`dimensions`, `maxBatchSize`, `maxInputCharacters`, `encoding` and `fingerprint`.
The character limit counts UTF-16 units; the provider must additionally enforce
its real tokenizer limit. The fingerprint must change with weights, tokenizer,
query/document instructions or other encoding-affecting configuration. It keys
rebuildable vectors, not document permissions. Registry `generation(binding)` is
separate: it fences a registration lifetime so unloading/replacing an engine
invalidates in-flight work even when the encoding fingerprint is unchanged.

Consumers call `registry.embed(request, binding)` and receive `{ vectors, model }`;
`list/subscribe` drive the dynamic settings catalog. Selection is captured per
request. Removing a provider aborts its active requests; retrieval also rejects
late results from the old generation. Settings retain a missing selection while the catalog removes the unloaded provider.
Only `pdf_find_related`'s explicit `auto` mode may report a lexical fallback;
explicit semantic/hybrid requests do not switch engines or silently degrade.

The included local adapter targets the embedding-only launcher documented in
[the experiment](RETRIEVAL_EXPERIMENT.md). It allows loopback endpoints, requires
matching non-truncating model metadata at `/v1/models`, and verifies the
`model_revision` echoed by `/v1/embeddings`. It is not a promise that any endpoint
using the OpenAI JSON envelope is compatible. No remote engine is selected or
registered by default; contributors implementing one must declare
`execution: 'remote'` and own their credential integration.

## Directory and lifecycle

- Each typed service owns its implementation directory and exposes `list()` / `subscribe()`. `pdfCapabilities` reports the service's profile-default capability and returns that same service; it is not a second engine-selection store. PDF use cases validate their explicit feature bindings through the typed services, without changing another consumer's default.
- `EngineCatalog` observes those sources. `pdf.engines` publishes descriptor-only snapshots over the existing authenticated connection, using a revision-fenced long poll. It works outside a resource session; it does not return credentials, field values or implementation functions.
- The Client reconciles translation proxies by descriptor, so unrelated registrations do not cancel active translations. Settings and capability checks refresh when catalog/settings change. Session-specific availability is checked in Host at use time, not inferred from installation.
- Removing an engine cancels its active tasks and availability probes. Late output is discarded. Registrations are identity fenced: an old disposer cannot remove a replacement with the same ID. Implementations must forward `AbortSignal` to their own network/process I/O and release resources when their Fiber unloads.
- A missing selection stays selected and displays as unavailable. No silent local/remote fallback occurs. Disconnects retain the last directory until reconnection; they are not interpreted as provider removal.
- Per-request configuration is captured before asynchronous work. OCR/image consumers can use independent bindings; Host translations use request-scoped instances rather than mutating one global selection.

Automatic PDF character-map repair deliberately remains a separate, fixed local path requiring positioned words. It never follows the user-selected remote OCR engine. Engine extensibility does not change source authorization, evidence validation, draft ownership or save approval.
