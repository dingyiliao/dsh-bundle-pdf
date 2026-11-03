# Engine extensions

Extend an existing Host service from an independent DSH plugin. Registration adds
the engine to PDF settings; no Client entry or PDF source changes are required.

| Service to inject | Public SDK import | Backend contract |
| --- | --- | --- |
| `ocr` | `@dylanl1/dsh-plugin-pdf/ocr-host` | `HostOcrBackend`: image → recognized text and optional geometry |
| `imageUnderstanding` | `@dylanl1/dsh-plugin-pdf/image-host` | `ImageUnderstandingBackend`: PNG + prompt → generated text |
| `pdfTranslation` | `@dylanl1/dsh-plugin-pdf/translation` | `TranslationEngine`: selected text + target language → translation or lexical detail |
| `pdfEmbedding` | `@dylanl1/dsh-plugin-pdf/embedding` | `EmbeddingEngine`: text batch → vectors |

Shared descriptors, configuration and bindings are exported from
`@dylanl1/dsh-plugin-pdf/engines`; OCR output types are exported from
`@dylanl1/dsh-plugin-pdf/ocr`. These are public subpaths of the main npm package.
Do not import another checkout's `src/` or `dist/types/` files.

## Package and registration

Start with the buildable [`http-engines` example](../examples/http-engines).
Its [manifest](../examples/http-engines/package.json) declares the PDF package and
Cordis as peer dependencies and development dependencies; its
[bundle patch](../examples/http-engines/cordis.patch.yml) mounts the Host entry.
For a package using the same SDK versions:

```sh
npm install --save-dev @dylanl1/dsh-plugin-pdf@^0.1.5 @deepseek-ai/cordis@4.0.5
```

Build the entry before installing a local or Git package. Load it in the same
Host profile as the PDF bundle; see [installation](../README.md#install).
`peerDependencies` declares compatibility, while `inject` waits for the existing
Host service. Keep SDK runtime dependencies external when bundling. Type-only
imports are erased and do not mount services.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { HostOcrBackend } from '@dylanl1/dsh-plugin-pdf/ocr-host'
import { backend } from './backend.js'

export const inject = ['ocr']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.ocr.register(backend satisfies HostOcrBackend))
}
```

Each service's `register()` returns a disposer owned by the contributor's Fiber.
Use the existing service rather than creating a second registry. The other three
services follow the same registration pattern.

## Descriptor and configuration

Every backend declares `descriptor.id`, `name`, `version` and `execution`
(`local`, `remote`, `service` or `disabled`). Use stable namespaced IDs such as
`example.http-ocr`. The typed OCR and image services advertise `ocr-text` and
`image-description` respectively; these are separate execution contracts.

Optional `configurationFields` declares up to 32 fields, each with `key`, `label`,
`type` and optional `required`. Supported types are `string`, `number`, `boolean`
and `secret-reference`. Settings render these fields and retain configuration
under its engine kind and ID:

```yaml
ocrEngine: example.http-ocr
engineConfigurations:
  ocr:
    example.http-ocr:
      endpoint: https://ocr.example/api
```

The kinds are `ocr`, `image`, `translation` and `embedding`. The service passes
configuration as the backend method's second argument. Declare all accepted
fields so settings can render them. OCR, image and embedding reject unknown keys;
translation validates contributed fields when `configurationFields` is declared.
A `secret-reference` is an opaque credential name, not an API key; resolve it in
Host code.

Switching engines retains other engines' saved configuration. OCR, image and
embedding consumers may supply an explicit `{ engineId, config }` binding without
changing the Reader's selection; translation uses configured instances.
OCR/image availability is session-specific and checked at execution time;
installation alone does not prove that a model or endpoint is usable.

## Execution contracts

### OCR

`availability(sessionId, signal, configuration)` returns an OCR availability
status. `recognize(request, configuration)` receives encoded image bytes or a
Blob, media type, dimensions, languages, session identity and cancellation signal.

Return `OcrOutput`: `text`, `blocks`, `lines`, `words`, `confidence`, `status`,
`coverage` and `warnings`. Positions use input-image pixels with a top-left
origin. Use empty geometry arrays and `null` confidence when unavailable; do not
invent positions or confidence. An empty successful transcription is valid.

### Image understanding

`availability(sessionId, signal, configuration)` returns `{ available: true }`
or `{ available: false, reason }`. `understand(request, configuration)` receives
`{ sessionId, image, prompt, signal, binding? }`; `image` contains PNG `data`,
`mediaType`, `width` and `height`.

Return `{ text, model?, limitations? }` with nonempty text. The service adds
`source: { backendId, backendVersion, model? }`. Interactive questions and index
descriptions use the same backend with different prompts.

### Translation

`translate(request, configuration)` receives the exact selected text, target
language, optional source language and adjacent context, plus `signal`,
`timeoutMs` and `maxOutputCharacters`.

Return `{ text, status, warnings }`. Optional `detail` contains `kind`
(`word` or `phrase`), pronunciation and a `meanings` array; each meaning contains
`partOfSpeech`, `meaning`, `example` and `exampleTranslation`.

When correcting or completing extracted text, optionally return `interpretation`:
`{ text, kind: 'correction' | 'completion', certainty: 'confident' | 'tentative', explanation }`.
This identifies the source used for the result while preserving the original
selection. Only complete results may carry it; interpreted text is limited to
8192 UTF-16 units and its explanation to 500, within the request's output budget.
The engine decides meaning and uncertainty; the registry validates structure and
limits rather than deciding whether the selection is translatable.

### Embedding

Provide synchronous, side-effect-free `describe(configuration)`, optional
`availability(configuration, signal)`, and `embed(request, configuration)`.
The request contains `texts`, `purpose: 'query' | 'document'`, `signal` and
`timeoutMs`. Return vectors in input order, or `{ vectors, model }` to report the
exact encoding identity verified for that operation. The registry checks model
identity, count, dimensions, finite values and nonzero norm, then L2-normalizes.
Reject excessive input rather than silently truncating it.

`describe()` returns `EmbeddingModel`: `engineId`, `engineVersion`, `model`,
`modelRevision`, `dimensions`, `maxBatchSize`, `maxInputCharacters`, `encoding`
and `fingerprint`. The character limit counts UTF-16 units; providers must also
enforce tokenizer limits. `modelRevision` is provider-owned metadata, not a
required user setting. Change the fingerprint when weights, tokenizer,
instructions or other encoding behavior changes.

Optional `documentFingerprint` identifies document encoding alone. Query-only
instructions and transport batch sizes may leave it unchanged; document weights,
tokenizer, dimensions or document instructions must change it. Without this
identity, document-vector reuse conservatively includes the full binding.

## Cache identity

OCR and image backends may implement
`cacheIdentity(sessionId, signal, configuration)`. Return a stable nonempty string
only when it identifies the actual model and all output-affecting behavior across
restarts. The Host combines it with the descriptor and configuration. An engine
ID or endpoint alone cannot identify a mutable model.

Without a stable identity, or with `{ identity, reusable: false }`, derived caches
are isolated by session and registration lifetime. Stable identities permit
persistent reuse; they do not bypass source freshness, rendered-input,
availability or authorization checks. Keep identity probes bounded and forward
cancellation. Registration generation separately rejects late output after an
engine unload or replacement.

## Lifecycle and errors

- `list()` and `subscribe()` drive the dynamic catalog. Unloading removes the
  engine from the list while retaining a user's missing selection as unavailable.
  It never silently selects another local or remote backend.
- Unregistering cancels active requests and availability probes; late results are
  discarded. Forward `AbortSignal` to network/process work and dispose owned
  workers or connections through the contributor's Fiber.
- Report configuration or availability failures before inference. Reject failed
  operations; do not disguise a failure as an empty successful result. Respect
  request deadlines and output limits, including while streaming.
- Plugin code executes in Host and is trusted code. Keep credentials in Host,
  avoid leaking secrets in errors or descriptors, and make remote data transfer
  explicit. An index build may send document images/text before a search query.
- OCR geometry and generated descriptions do not certify native text positions.
  Extensions do not replace document authorization, evidence validation or shared
  draft ownership. The Reader's automatic character-layer repair is a separate
  local path, not an extension-selected OCR request.

The [example tests](../tests/examples/engine-extensions.test.ts) exercise the actual
HTTP adapters, registration, configuration, cancellation and unload with mocked
HTTP responses. See the [testing guide](testing.md) for verification commands.
