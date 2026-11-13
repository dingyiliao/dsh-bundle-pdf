# Project coverage

`npm run test:coverage:project` measures project-owned production code across the
Node/Host unit suite, the built Client running in Chromium, and the instrumented
C++ PDF worker. The LocalOCR Worker source is exercised by Node tests and its
built entry is separately smoke-tested in Chromium; the browser smoke test does
not collect Worker coverage. The command merges source-level line hits
by file and line and fails until every measured production line is covered.
The generated report is under `.test-output/project-coverage-*/report.json`;
the same directory retains Node, browser and native LCOV inputs and native HTML.
The runner restores the ordinary Client build when collection ends, including
when a test or the 100% coverage gate fails.

Runtime prerequisites and test commands are in the [testing guide](docs/testing.md).

The TypeScript/TSX denominator is every source line that TypeScript maps to
emitted JavaScript under `src/` and `src/engine/`, excluding standalone closing braces with no
independently executable operation and static `import` linkage that the shipped
bundle resolves at build time. The report lists both kinds of excluded source
lines per file for audit. The C++ denominator comes from LLVM's line
summary for the worker and the implementation compiled with the selected SDK.
The build uses the pinned, patched PDFium SDK. Set `DSH_PDFIUM_ROOT` to the
SDK location if it is outside the default build cache. The linked PDFium library and patches
compiled into it are outside the LLVM instrumentation. A missing worker
source for the selected SDK is reported as *uninstrumented*,
never silently counted as 100%. The browser report maps
V8 ranges through the DSH bundle source map and seeds unexecuted Client source
locations as zero. The merge accepts only lines mapped to emitted JavaScript;
this avoids counting TS-only declarations that Node's experimental
`--test-coverage-include-all` can otherwise treat as lines. The Node lane must
run with `--enable-source-maps`: without it, Node labels transpiled-JavaScript
line numbers with TypeScript paths, so a cross-runtime merge would be invalid.
When V8 records an invoked function but no line hit on its declaration header,
the merger uses a matching LCOV function hit as evidence for that header only
when same-named functions cannot make the attribution ambiguous.
The native report
uses LLVM's line summary, which can include lines not individually listed as
`DA` in its LCOV export.

This is a **line-coverage gate**, not a claim of 100% branch, function,
interaction, platform, or behavioral coverage. In particular, a Node-only
report cannot establish full-project coverage, and the native LLVM report
also provides separate branch/function counts. Review those reports and the
Web E2E results alongside the merged line percentage.
