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

Prerequisites: Node 26.7+, an adjacent `deepseek-harness` checkout for Web E2E,
the pinned native dependencies (`npm run native:build`), and Chromium. If
Playwright's Chromium is not installed in its default location, set
`DSH_PDF_BROWSER_EXECUTABLE` to an absolute Chromium executable path. Browser
coverage runs the full Web interaction suite and requires local HTTP listeners.

The TypeScript/TSX denominator is every source line that TypeScript maps to
emitted JavaScript under `src/`, excluding standalone closing braces with no
independently executable operation and static `import` linkage that the shipped
bundle resolves at build time. The report lists both kinds of excluded source
lines per file for audit. The C++ denominator comes from LLVM's line
summary for `native/pdfium-worker.cpp`. This excludes erased type declarations,
CSS, tests, build scripts, generated bundles, and the prebuilt third-party
PDFium library. A missing runtime source is reported as *uninstrumented*,
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
