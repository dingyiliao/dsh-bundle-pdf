# PDFium patch queue

The plugin is built from the locked PDFium source revision in
`native/dependencies.json`. The queue is deliberately represented as
deterministic source transforms rather than a long-lived fork: the entry
scripts apply the same ordered changes to a clean checkout, and
`patchset.json` records every transform and extension source that contributes
to the resulting SDK.

`node native/pdfium/patchset.mjs` prints the patchset digest. A PDFium SDK
built by `build-pdfium-sdk.mjs` contains that digest in `DSH_PATCHSET`; the
worker build rejects an SDK whose source revision or patchset does not match
the checkout. Any upstream change must therefore either apply cleanly and
produce a reviewed new digest, or fail before the SDK is used.
