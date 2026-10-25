# DSH PDF Reader

English | [中文](README.zh.md)

Read a PDF alongside your [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversation. Ask a rough question, find the relevant passage, mark it in the document, and return to where you were reading.

I built this plugin because I often read papers and books in PDF form. The readers I tried were missing small but important conveniences—especially a way back after several jumps—while the ones with AI explanation and translation often required another subscription. This is the reader I wanted for my own DSH workspace.

## What it does

- **Read and find.** Continuous scrolling, zoom and fit modes, page thumbnails, text selection, and text search.
- **Navigate and return.** Jump through pages, links, bookmarks, or annotations, then choose an earlier position from multi-step back history.
- **Annotate.** Add highlights, underlines, strikeouts, comments and draggable, resizable page notes; edit colors and comment threads.
- **Edit bookmarks.** Add, rename, delete, reorder and nest the PDF's built-in bookmarks, then save them into the document.
- **Fill forms.** Fill existing AcroForm controls manually or let the model inspect numbered controls and fill one page at a time.
- **Save your work.** Undo/redo, recover drafts, save or save as, and detect source-file conflicts. User and model edits share the same draft; model-requested saves require approval.
- **Translate selections.** Get pronunciation, meanings, parts of speech and examples for words; meanings and examples for phrases; direct translations for sentences.
- **Ask in context.** Select several text passages or single-page image regions, attach a question to each, and send them together to the current conversation.
- **Capture and recognize.** Copy or download a page region, run OCR on a page or region, and use the configured image-understanding backend.
- **Let the model work with the PDF.** Read unread pages, find related passages, mark evidence, edit forms and bookmarks, and navigate an already visible Reader.
- **Extend AI engines.** Register OCR, image-understanding, translation and embedding implementations through plugin APIs; available engines appear in PDF settings.
- **Search by meaning (experimental).** Combine keyword matching with a local embedding model to find paraphrases and cross-language passages. Results remain original text references; incomplete indexing and image-only pages are reported explicitly. Embedding is off by default.

## Agent tools

The bundle provides the following tools. Image/OCR availability depends on the current model and selected backend; navigation requires an already visible Reader. See the [tool contracts](docs/AI_READER_TOOLS.md) for inputs and limits.

- `pdf_current` — List PDFs visible in the current conversation and their page hints.
- `pdf_open` — Open a PDF in the background and obtain its shared document reference.
- `pdf_close` — Release the model's document reference; Reader tabs keep their own references.
- `pdf_status` — Inspect revisions, unsaved changes, conflicts and available capabilities.
- `pdf_read_page` — Read a bounded text window from a specified page.
- `pdf_search` — Search for exact text and return source references.
- `pdf_find_related` — Find passages related to a question or concept and return source references.
- `pdf_locate` — Locate a quoted passage in the original page text.
- `pdf_context` — Read surrounding text for a position, quote or source reference.
- `pdf_render_page` — Return a page image or derived text from the configured image-understanding backend.
- `pdf_ocr_page` — Recognize text on a page using the selected OCR backend.
- `pdf_image_context` — Retrieve previously recorded image or OCR evidence after revalidation.
- `pdf_form_inspect_page` — Return a page image with numbered writable controls and their types/options.
- `pdf_fill_form` — Fill one inspected page atomically in the shared draft.
- `pdf_page_annotations` — List a page's annotations, comments and exact IDs.
- `pdf_annotate` — Add a highlight, underline, strikeout or page note; text ranges can span pages.
- `pdf_annotation_update` — Update text-mark colors or the text of a mark, note or comment reply.
- `pdf_annotation_delete` — Delete an editable annotation or comment reply by ID.
- `pdf_bookmarks` — Read the PDF's built-in bookmark tree and IDs.
- `pdf_outline_edit` — Add, rename, delete, reorder or reparent built-in bookmarks.
- `pdf_navigate` — Jump to a verified passage or page in a visible Reader, preserving back history.
- `pdf_save` — Request user approval and save the current draft over its source PDF.
- `ocr_recognize` — Transcribe a session-scoped image handle; provided by the bundled OCR plugin.

## Preview

The agent can mark a passage and add a comment directly to the PDF draft:

![Agent adds a highlight and comment to the PDF](docs/screenshots/01-ai-edits-pdf.png)

After several jumps, pick any earlier reading position from the back-history menu:

![Multi-step PDF reading history](docs/screenshots/04-multilevel-back-history.png)

See also [bookmarks and outline](docs/screenshots/02-bookmarks-and-outline.png) and [notes and annotations](docs/screenshots/03-notes-and-annotations.png).

## Install

Validated with DSH `0.2.1-rc.3`. Supported runtime versions are declared in [package.json](package.json); the test SDK and browser-test host are pinned to the validated release.

This plugin is not published to npm. Download the `dsh-pdf-npm-package-<target>` artifact for your OS and CPU from a successful [GitHub Actions run](https://github.com/dingyiliao/dsh-bundle-pdf/actions) on `main`. Unzip it and install the `.tgz` inside. Available targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `win32-x64`. Check [package.json](package.json) for compatible DSH versions.

For an existing Web profile:

```sh
dsh plugin --profile web add /absolute/path/to/package.tgz
dsh web
```

For Desktop, first launch the app to create its `desktop` profile, then quit it completely. Install the app's own CLI using **Manage dsh Command…** in the Desktop menu, and run:

```sh
dsh plugin --profile desktop add /absolute/path/to/package.tgz
```

Reopen Desktop afterward. A separately installed npm `dsh` command does not manage the Desktop profile.

Open an accessible local PDF from DSH's file sidebar to start reading. The plugin uses your configured DSH models and credentials; it does not provide a free model. Image understanding and OCR depend on the selected model or a separately configured backend.

Pages with broken character mappings are repaired locally for selection and reading, without uploading or rewriting the PDF. This is an approximate OCR fallback, not automatic OCR for scanned documents.

## Architecture

```mermaid
flowchart TB
  subgraph Client["Client · Presentation"]
    Reader["PDF Reader"]
    Settings["PDF settings<br/>Live engine catalog and configuration"]
  end
  subgraph Host["Host · Authority"]
    RPC["Authenticated RPC"]
    Tools["Agent tools"]
    Features["PDF and AI use cases"]
    Copy["Shared working copy<br/>Drafts, revisions, undo, save"]
    AI["Typed services<br/>OCR · Image understanding · Translation · Embedding"]
    Retrieval["Text retrieval<br/>BM25 + embeddings · Rebuildable cache"]
    Evidence["Existing evidence references<br/>Revalidate before marking or navigation"]
    Catalog["Read-only engine catalog<br/>Change notifications"]
    Config["Per-feature engine bindings<br/>Configuration and credential references"]
    Backends["Default and contributor engines<br/>Same registration / Fiber-owned disposal"]
    Native["PDF adapters<br/>pdf-lib · Native PDFium"]
    Files["Files and draft storage"]
    RPC --> Features
    Tools --> Features
    Features --> Copy
    Features --> AI
    Features --> Retrieval
    Retrieval --> AI
    Retrieval --> Evidence
    Evidence --> Copy
    Copy --> Native
    Copy --> Files
    AI --> Backends
    AI --> Config
    AI -. "Descriptor changes" .-> Catalog
    Catalog --> RPC
    RPC --> Config
  end
  Reader <--> RPC
  Settings <--> RPC
  Model["DSH conversation model"] <--> Tools
  Backends --> Dependencies["DSH LLM · Local workers · Remote APIs"]
```

The Client and agent tools share one Host-side working copy per resource session and canonical path. A background-opened PDF can later be adopted by the Reader with the same document ID, draft and undo history; changes synchronize in both directions. Closing a view releases its reference, not the draft. Idle resource eviction keeps the document identity and restores its working set on demand. Reading does not open a sidebar tab, and an agent-requested overwrite still requires approval. The native worker handles rendering and text extraction behind the Host boundary.

Host plugins can register OCR, image-understanding, translation and embedding engines. The settings catalog updates on registration and removal; unloaded selections remain visible. Requests capture their engine/configuration, and unloading cancels that engine's active work. Each service retains its typed API; the catalog is not another execution registry. Only retrieval's explicit `auto` mode may report a lexical fallback. See [engine extensions](docs/ENGINE_EXTENSIONS.md) for contributor contracts. Automatic character-map repair remains a separate local-only path, never routed to a selected remote OCR engine.

The `pdf_search` and `pdf_find_related` tools start with a document, query and options, then return `searchId` and `hasMore`. To continue, the model passes only that ID to the same tool; Host retains the query and progress. Related results are ranked only after the requested scope is fully indexed. See the [tool contracts](docs/AI_READER_TOOLS.md) for coverage and search-session lifetime rules.

Bookmark edits use the shared outline domain and the existing pdf-lib save transaction. The agent can obtain exact `outlineId` values with `pdf_bookmarks`, then submit an atomic draft edit through `pdf_outline_edit`. New outline-edit interactions still need real Desktop and external-reader acceptance testing.

See the [architecture](docs/ARCHITECTURE_V2.md), [AI reader tools](docs/AI_READER_TOOLS.md), and [specification](SPEC.md) for contracts and implementation status. Some advanced tool interactions still need real Desktop and model-based acceptance testing.

Form inspection returns a numbered page image and the writable controls on that page, including their types, options and positions. Each small translucent F label sits inside its control. The calling model matches those controls to the printed content; inspection does not make an additional model or OCR request.

## Development

For a source checkout, run `npm ci`, `npm run native:build`, and `npm run build`, then install the directory with `dsh plugin --profile web add .`. A Git URL installation does not include a prebuilt native worker. Run `npm run check` for type and Node tests, `npm run test:web` for browser interactions, and `npm run test:coverage:project` for project coverage.

For experimental semantic retrieval, you can reuse an existing Apple Silicon MLX environment and cached Qwen3 embedding model:

```sh
/absolute/path/to/mlx-lm-local-demo/.venv/bin/python scripts/local-embedding-server.py --port 8001
```

Then choose **Local Qwen3 embedding** in PDF settings. The launcher starts only the embedding service, downloads nothing, and remains a separately managed process. It requires the cached model and dependencies described in the [experiment setup and measurements](docs/RETRIEVAL_EXPERIMENT.md). `npm run bench:retrieval` runs the model-free baseline; that document also gives the real-model command. Semantic retrieval is experimental and off by default; availability depends on the build or release you install. Images, charts and formula layout are not indexed by the text retriever.

Ordinary AcroForm fields can be filled in the Reader or by the model. Inspection puts small IDs inside controls on a base-page image without widget appearances or annotations; current draft values are available through `includeValues:true` metadata, not the deliberately blank-looking image. Each fill atomically updates one page of the shared undoable draft using a single inspection ID and label/value entries; the Host restores the page. Inspect multiple pages together, then fill independent pages in separate calls. Shared-field and declared-dependency conflicts require reinspection. The model can supply explicit conditional and exclusive-choice checks; the Host validates those supplied rules and field types without inferring business meaning. Inspection needs a vision-capable model; overwriting the PDF still requires approval. PDF scripts and actions are not executed; signed PDFs remain read-only and signatures are not verified. XFA and encrypted PDFs are not supported. Text search does not automatically index scanned pages, and a background `pdf_open` tool call does not open a Reader tab. See [SPEC.md](SPEC.md) for the remaining limits.

Draft storage still uses `format: 1`, but older binaries do not understand the new outline operations or ID-targeted form edits. Before downgrading, save or discard form/outline drafts and back up both the PDF and plugin storage. This is not a claim of compatibility with old binaries for new operation types.

## License

[MIT](LICENSE). Bundled third-party licenses are listed in `dist/THIRD_PARTY_NOTICES.md` and `dist/native/`.
