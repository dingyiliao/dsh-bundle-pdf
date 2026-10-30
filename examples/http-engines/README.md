# HTTP OCR and image-understanding engines

A small independent Host plugin. It uses the published PDF SDK's type imports,
registers through `ctx.ocr` / `ctx.imageUnderstanding`, and unregisters through
`ctx.effect()` when Cordis unloads it. Registration and removal update PDF settings
automatically. No Client entry or PDF source patch is needed.

The two endpoints below are **example protocols**, not OpenAI-compatible APIs.
Replace the request/response mapping in `src/backends.ts` for your provider.

## Run

1. Copy this folder outside the PDF repository. If you rename the package, update
   both `package.json` and its name in `cordis.patch.yml`.
2. Install a PDF SDK build containing the `understand()` contract. While developing
   against this checkout, run the root `npm run build` first, then in the example:

   ```sh
   npm install --save-dev /absolute/path/to/dsh-bundle-pdf --omit=optional
   ```

   This uses the local package's public exports and built declarations, not its
   source paths. Use a released SDK containing this contract when available.
3. Run `npm install`, `npm run check`, and `npm run build` in the example folder.
4. Load the folder in the same **Host profile** as the PDF plugin:

   ```sh
   dsh plugin --profile <profile> add /absolute/path/to/http-engines
   ```

5. In PDF settings, select **Example HTTP OCR** or **Example HTTP vision** and set
   its **HTTP endpoint**. The selected engines also serve the corresponding text
   recognition and visual description index switches.

`dsh.bundle.patch` mounts this package's Host entry; `peerDependencies` declares
compatibility and `inject` waits for the existing Host services. Build before
installing a Git/local package: the repository supplies
source, and this example deliberately has no install-time build script.

## Endpoint contract

OCR receives `POST` JSON:

```json
{
  "image": { "mediaType": "image/png", "width": 800, "height": 1000, "base64": "..." },
  "languages": ["auto"]
}
```

Vision receives the same `image` and a `prompt` string instead of `languages`.
Both return `{ "text": "..." }`; vision may also return `"model": "..."`.
An empty OCR text result is valid. Vision should return an actual interpretation.
The OCR adapter reports no invented word boxes or confidence values. A provider
with real geometry can extend that conversion using input-image pixel positions.

The example sends images only when invoked and forwards cancellation to `fetch`.
Choose an endpoint you trust: it receives the submitted image and prompt. Use
HTTPS for remote deployment. This minimal example has no authentication; add
Host-side credential resolution for an authenticated provider, with only a
`secret-reference` field exposed to settings. Never place API keys in endpoints
or the settings JSON.

No stable `cacheIdentity()` is claimed because the endpoint may change its model.
The Host therefore isolates derived caches by session and registration lifetime.
Add a stable identity only when your service can attest its actual model and
output-affecting revision; an endpoint URL alone is insufficient.

## Tests

From the PDF repository root:

```sh
node --import tsx --test tests/examples/engine-extensions.test.ts
```

The tests import these actual backends, mock HTTP responses, and use the real Host
services/catalog to check execution, configuration, cancellation and unload. They
make no network calls and require no OCR/vision model.
