# HTTP OCR and image-understanding engines

An independent Host plugin using the PDF package's public SDK. It registers
`example.http-ocr` and `example.http-vision` in the existing Host services.
Loading or unloading the plugin updates the engine list in PDF settings.

## Build and use

1. Copy this folder into your own package. If you rename it, update both
   `package.json` and `cordis.patch.yml`.
2. Install the declared development dependencies and build:

   ```sh
   npm install --omit=optional
   npm run check
   npm run build
   ```

3. With the [PDF plugin installed](../../README.md#install), add the example to
   the same Host profile:

   ```sh
   dsh plugin --profile <profile> add /absolute/path/to/http-engines
   ```

4. Select **Example HTTP OCR** or **Example HTTP vision** in PDF settings and
   configure its **HTTP endpoint**.

`dsh.bundle.patch` mounts the Host entry; `inject` waits for `ocr` and
`imageUnderstanding`. Build before installing: this example has no install-time
build script. `--omit=optional` skips native binaries in the development copy;
the running PDF plugin still needs its platform package.

## Endpoint protocol

These are example protocols, not OpenAI-compatible APIs. Adapt the mapping in
[`src/backends.ts`](src/backends.ts) to your provider.

OCR receives a JSON `POST`:

```json
{
  "image": { "mediaType": "image/png", "width": 800, "height": 1000, "base64": "..." },
  "languages": ["auto"]
}
```

Vision receives the same `image` and a `prompt` string instead of `languages`.
Both return `{ "text": "..." }`; vision may also return `"model": "..."`.
Empty OCR text is valid. Vision must return nonempty text. The OCR adapter emits
no word boxes or confidence scores; add them only if the service supplies actual
input-image pixel positions and confidence.

The adapters send data only when invoked and forward cancellation to `fetch`.
Use a trusted endpoint and HTTPS remotely. Authentication is not implemented;
add Host-side credential resolution for your provider rather than putting API
keys in URLs or settings JSON.

No stable `cacheIdentity()` is claimed because the endpoint may change its model.
Derived caches are therefore scoped to session and registration lifetime. Add a
stable identity only when the service can attest its actual model and
output-affecting revision; a URL alone is insufficient.

See [engine contracts](../../docs/engine-extensions.md) and the
[testing guide](../../docs/testing.md). The repository's
[`engine-extensions.test.ts`](https://github.com/dingyiliao/dsh-bundle-pdf/blob/main/tests/examples/engine-extensions.test.ts)
tests these backends with mocked HTTP responses; it does not contact a model.
