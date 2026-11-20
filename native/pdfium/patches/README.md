# PDFium patch queue

The SDK is built from the PDFium source revision locked in `native/dependencies.json`. Every source change, including DSH extension files and GN registration, is carried by the ordered unified-diff `.patch` files listed in `patchset.json`; there are no source-transform or copy scripts in the patch pipeline.

The build requires a clean checkout at the locked revision. For each entry it runs `git apply --check` and then `git apply` from the checkout root. The queue is intentionally not idempotent: apply it once to a fresh checkout. A changed upstream revision or patch context fails instead of being fuzzed into place.

`node native/pdfium/patchset.mjs` prints the patchset digest. The digest covers the locked source revision, ordered patch IDs/paths, and exact patch bytes. A built SDK stores it in `DSH_PATCHSET`; Native build rejects an SDK with a mismatched revision or digest.
