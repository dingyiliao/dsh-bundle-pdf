# Engine extensions

OCR, image understanding and translation are Host services, not Reader components. Contributors inject the service they extend and own the registration disposer through `ctx.effect()`. They do not need a Client entry or changes to PDF settings. Plugin code is trusted executable code, not a sandbox boundary.

| Service | Public types | Execution contract |
| --- | --- | --- |
| `ocr` | `@local/dsh-pdf/ocr-host` | `recognize(request, configuration)` returns validated OCR text and optional image-pixel geometry |
| `imageUnderstanding` | `@local/dsh-pdf/image-host` | `prepare(request, configuration)` returns a direct-image route or derived text with provenance |
| `pdfTranslation` | `@local/dsh-pdf/translation` | `translate(request, configuration)` returns a translation and optional lexical details |

Common descriptors, bindings and configuration types are exported from `@local/dsh-pdf/engines`. Use stable, namespaced IDs such as `example.local-ocr`. A descriptor includes `id`, `name`, `version`, `execution` and optional `configurationFields`. Image backends also declare `id` and `kind`; their descriptor must use the same ID. Legacy image backends without descriptors receive an ID-based display name.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { HostOcrBackend } from '@local/dsh-pdf/ocr-host'

export const inject = ['ocr']

// Implement this contract using a local engine or a remote service.
declare const backend: HostOcrBackend

export function apply(ctx: Context) {
  ctx.effect(() => ctx.ocr.register(backend))
}
```

## Configuration and selection

The Reader config provides `ocrEngine`, `imageEngine`, `translationEngine` and `engineConfigurations`. Configuration is retained independently for each kind/engine ID (`ocr`, `image`, `translation`); switching engines does not delete the previous configuration. Each feature binding acts as its own instance. Other Host consumers may pass a different `binding` to OCR/image requests or an explicit instance to `TranslationRegistry.translate()` without changing the Reader's choice.

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

## Directory and lifecycle

- Each typed service owns its implementation directory and exposes `list()` / `subscribe()`. `pdfCapabilities` reports the service's profile-default capability and returns that same service; it is not a second engine-selection store. PDF use cases validate their explicit feature bindings through the typed services, without changing another consumer's default.
- `EngineCatalog` observes those sources. `pdf.engines` publishes descriptor-only snapshots over the existing authenticated connection, using a revision-fenced long poll. It works outside a resource session; it does not return credentials, field values or implementation functions.
- The Client reconciles translation proxies by descriptor, so unrelated registrations do not cancel active translations. Settings and capability checks refresh when catalog/settings change. Session-specific availability is checked in Host at use time, not inferred from installation.
- Removing an engine cancels its active tasks and availability probes. Late output is discarded. Registrations are identity fenced: an old disposer cannot remove a replacement with the same ID. Implementations must forward `AbortSignal` to their own network/process I/O and release resources when their Fiber unloads.
- A missing selection stays selected and displays as unavailable. No silent local/remote fallback occurs. Disconnects retain the last directory until reconnection; they are not interpreted as provider removal.
- Per-request configuration is captured before asynchronous work. OCR/image consumers can use independent bindings; Host translations use request-scoped instances rather than mutating one global selection.

Automatic PDF character-map repair deliberately remains a separate, fixed local path requiring positioned words. It never follows the user-selected remote OCR engine. Engine extensibility does not change source authorization, evidence validation, draft ownership or save approval.
