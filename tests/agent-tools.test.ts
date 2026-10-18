import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerPdfAgentTools, summarizeOutline, windowPageText } from '../src/host/agent-tools.ts'
import { createBookmarkService, type BookmarkRecord } from '../src/host/bookmarks.ts'
import { createPdfService } from '../src/host/pdf-service.ts'
import { nativeTestSubprocess } from './native-test-subprocess.ts'
import { createReaderContexts } from '../src/host/reader-contexts.ts'
import { memoryWorkspace, nativeFixture } from './native-fixture.ts'

interface CapturedTool {
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; attachment?: { attachmentId: string } }> }
}

const signal = new AbortController().signal
const nativeExecutable = process.env.DSH_PDF_NATIVE_HELPER
  ?? resolve(`dist/native/dsh-pdf-native${process.platform === 'win32' ? '.exe' : ''}`)
if (process.env.DSH_PDF_REQUIRE_NATIVE_TESTS === '1' && !existsSync(nativeExecutable)) {
  throw new Error('Native tests require a built helper')
}

function agent(sessionId: string) {
  return { session: { id: sessionId, header: {} } }
}

function captureTools(services: Record<string, unknown> = {}) {
  const definitions = new Map<string, CapturedTool>()
  const ctx = {
    get(name: string) { return services[name] },
    tools: {
      register(definition: CapturedTool & { name: string }) {
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      },
    },
  } as unknown as Parameters<typeof registerPdfAgentTools>[0]
  return { ctx, definitions }
}

function readTool(definitions: Map<string, CapturedTool>, name: string, args: unknown, sessionId?: string) {
  const definition = definitions.get(name)
  assert.ok(definition, `${name} must be registered`)
  return definition.execute(args, {
    signal,
    ...(sessionId === undefined ? {} : { agent: agent(sessionId) }),
  })
}

test('PDF text windows preserve every UTF-16 code unit without splitting a supplementary character', () => {
  const source = 'A😀B𝌆C'
  const pieces: string[] = []
  let offset = 0
  for (let index = 0; index < 10; index++) {
    const window = windowPageText(source, offset, 2)
    assert.equal(window.offset, offset)
    assert.equal(window.totalChars, source.length)
    assert.ok(window.text.length > 0)
    assert.ok(window.text.length <= 2)
    assert.doesNotMatch(window.text, /[\uD800-\uDBFF]$/u)
    assert.doesNotMatch(window.text, /^[\uDC00-\uDFFF]/u)
    pieces.push(window.text)
    if (window.nextOffset === null) {
      assert.equal(window.truncated, false)
      break
    }
    assert.equal(window.truncated, true)
    assert.ok(window.nextOffset > offset)
    offset = window.nextOffset
  }
  assert.equal(pieces.join(''), source)
  assert.throws(() => windowPageText(source, 2, 2), /offset|boundary|surrogate/i)
  assert.throws(() => windowPageText(source, 0, 1), /maxChars|limit|length|window/i)
  assert.throws(() => windowPageText(source, source.length + 1, 2), /offset|range|window/i)
  const cjk = windowPageText('中'.repeat(8000), 0, 8000)
  assert.ok(Buffer.byteLength(cjk.text, 'utf8') <= 16_000)
  assert.ok(cjk.nextOffset !== null)
})

test('pdf_open reuses a caller-owned Host working copy without publishing a reader tab', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const { ctx, definitions } = captureTools()
  let visibleChecks = 0
  const nativeClosed: string[] = []
  registerPdfAgentTools(ctx, state.workspaces,
    { async releaseDocument(id: string) { nativeClosed.push(id) } } as never,
    { current: () => { visibleChecks++; return [] } })
  try {
    const first = await readTool(definitions, 'pdf_open', { path: '/fixtures/native.pdf' }, 'pdf-open-alice') as Record<string, unknown>
    assert.equal(first.status, 'opened')
    assert.equal(first.path, '/fixtures/native.pdf')
    assert.equal(first.pageCount, 4)
    assert.equal(first.readerUiOpened, false)
    assert.equal(visibleChecks, 0, 'Host open must not signal or inspect Client reader state')
    const reopened = await readTool(definitions, 'pdf_open', { path: '/fixtures/native.pdf' }, 'pdf-open-alice') as Record<string, unknown>
    assert.equal(reopened.documentId, first.documentId, 'same-session open must reuse its working copy')
    const other = await readTool(definitions, 'pdf_open', { path: '/fixtures/native.pdf' }, 'pdf-open-bob') as Record<string, unknown>
    assert.notEqual(other.documentId, first.documentId, 'working copies are session-scoped')
    await assert.rejects(readTool(definitions, 'pdf_open', { path: '/fixtures/native.pdf' }), /session/i)
    await assert.rejects(readTool(definitions, 'pdf_open', { path: '/fixtures/native.txt' }, 'pdf-open-alice'), /pdf/i)
    await assert.rejects(readTool(definitions, 'pdf_open', { path: '/missing/native.pdf' }, 'pdf-open-alice'), /unknown|not found|exist/i)
    assert.throws(() => state.workspaces.readSnapshot('pdf-open-bob', String(first.documentId)), /session|belong|access/i)
    await assert.rejects(readTool(definitions, 'pdf_ocr_page', {
      documentId: first.documentId, page: 1,
    }, 'pdf-open-alice'), /ocr plugin|unavailable/i)
    const closed = await readTool(definitions, 'pdf_close', { documentId: first.documentId }, 'pdf-open-alice') as Record<string, unknown>
    assert.equal(closed.status, 'released')
    assert.deepEqual(nativeClosed, [first.documentId])
    assert.throws(() => state.workspaces.readSnapshot('pdf-open-alice', String(first.documentId)), /unavailable|reopen/i)
    assert.ok(state.workspaces.readSnapshot('pdf-open-bob', String(other.documentId)))
    const reopenedAfterClose = await readTool(definitions, 'pdf_open', { path: '/fixtures/native.pdf' }, 'pdf-open-alice') as Record<string, unknown>
    assert.notEqual(reopenedAfterClose.documentId, first.documentId)
    const uiOpened = await state.workspaces.execute('pdf-open-alice', {
      action: 'open', sessionId: 'pdf-open-alice',
      address: 'dsh-resource://file/session/pdf-open-alice//fixtures/native.pdf',
    }, agent('pdf-open-alice'), signal)
    assert.ok('bytes' in uiOpened)
    assert.equal(uiOpened.id, reopenedAfterClose.documentId)
    const retained = await readTool(definitions, 'pdf_close', { documentId: uiOpened.id }, 'pdf-open-alice') as Record<string, unknown>
    assert.equal(retained.status, 'retained-ui')
    assert.ok(state.workspaces.readSnapshot('pdf-open-alice', uiOpened.id))
    await assert.rejects(readTool(definitions, 'pdf_close', { documentId: uiOpened.id }, 'pdf-open-bob'), /session/i)
  } finally { await state.workspaces.dispose() }
})

test('pdf_bookmarks lists personal and native outline items with bounded, session-fenced pages', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-bookmark-agent'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const rows = new Map<string, BookmarkRecord>()
  const bookmarks = createBookmarkService(state.workspaces, {
    get: key => rows.get(key), async put(key, value) { rows.set(key, value) }, async delete(key) { rows.delete(key) },
  })
  const position = { page: 2, x: 0, y: 0, scale: 1, fit: 'page' as const }
  await bookmarks.dispatch(sessionId, { action: 'add', sessionId, id: opened.id, title: 'Mine', position }, agent(sessionId), signal)
  const outline = [{ title: 'Chapter', dest: [0, { name: 'Fit' }], items: [
    { title: 'Section', dest: [2, { name: 'Fit' }], items: [] },
  ] }, { title: 'External', url: 'https://example.com', items: [] }]
  const pdfService = {
    async readOutline(callerSession: string, documentId: string) {
      return { snapshot: state.workspaces.readSnapshot(callerSession, documentId), items: outline }
    },
  }
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, pdfService as never, { current: () => [] }, bookmarks)
  try {
    const first = await readTool(definitions, 'pdf_bookmarks', {
      documentId: opened.id, limit: 2,
    }, sessionId) as { total: number; entries: Array<Record<string, unknown>>; nextCursor: number | null }
    assert.equal(first.total, 4)
    assert.deepEqual(first.entries.map(item => [item.kind, item.title, item.page]), [
      ['personal', 'Mine', 2], ['embedded', 'Chapter', 1],
    ])
    assert.equal(first.nextCursor, 2)
    const second = await readTool(definitions, 'pdf_bookmarks', {
      documentId: opened.id, cursor: first.nextCursor, limit: 2,
    }, sessionId) as typeof first
    assert.deepEqual(second.entries.map(item => [item.key, item.page, item.externalLink]), [
      ['0/0', 3, undefined], ['1', null, true],
    ])
    assert.equal(second.nextCursor, null)
    const personal = await readTool(definitions, 'pdf_bookmarks', {
      documentId: opened.id, kind: 'personal',
    }, sessionId) as typeof first
    assert.equal(personal.total, 1)
    await assert.rejects(readTool(definitions, 'pdf_bookmarks', { documentId: opened.id }, 'pdf-bookmark-other'), /session|belong|access/i)
    await assert.rejects(readTool(definitions, 'pdf_bookmarks', { documentId: opened.id, cursor: 5 }, sessionId), /cursor|outside/i)
  } finally {
    await bookmarks.dispose()
    await state.workspaces.dispose()
  }
})

test('pdf_bookmarks refuses an outline or final list from a different PDF revision', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-bookmarks-stale'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  let changeDuringRead = false
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, {
    async readOutline(callerSession: string, id: string) {
      const snapshot = state.workspaces.readSnapshot(callerSession, id)
      if (changeDuringRead) {
        await state.workspaces.execute(sessionId, { action: 'change', sessionId, id,
          revision: snapshot.revision, operations: [{ type: 'add', annotation: {
            id: 'new-bookmark-revision', page: 1, subtype: 'Text', rect: [20, 20, 30, 30],
          } }] }, agent(sessionId), signal)
        return { snapshot, items: [] }
      }
      return { snapshot: { ...snapshot, revision: snapshot.revision + 1 }, items: [] }
    },
    async releaseDocument() {},
  } as never, { current: () => [] }, { async dispatch() { return [] } } as never)
  try {
    await assert.rejects(readTool(definitions, 'pdf_bookmarks', {
      documentId: opened.id, kind: 'embedded',
    }, sessionId), { code: 'pdf/stale-reader' })
    changeDuringRead = true
    await assert.rejects(readTool(definitions, 'pdf_bookmarks', {
      documentId: opened.id, kind: 'embedded',
    }, sessionId), { code: 'pdf/stale-reader' })
  } finally { await state.workspaces.dispose() }
})

test('outline summaries keep hierarchy and never expose raw external URLs', () => {
  const summary = summarizeOutline([{ title: 'A', dest: [1, { name: 'Fit' }], url: 'https://example.com',
    items: [{ title: 'B', dest: [99, { name: 'Fit' }], items: [] }] }], 4)
  assert.deepEqual(summary.map(item => [item.key, item.depth, item.page]), [['0', 1, 2], ['0/0', 2, null]])
  assert.equal(summary[0]?.externalLink, true)
  assert.ok(!JSON.stringify(summary).includes('https://example.com'))
})

test('pdf_ocr_page refuses an unavailable backend before rendering a page', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-ocr-unavailable'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  let rendered = 0
  const { ctx, definitions } = captureTools({ ocr: {
    async availability() { return { status: 'disabled', reason: 'OCR is disabled in settings' } },
  } })
  registerPdfAgentTools(ctx, state.workspaces, { async renderPage() { rendered++; throw new Error('unreachable') } } as never,
    { current: () => [] })
  try {
    await assert.rejects(readTool(definitions, 'pdf_ocr_page', { documentId: opened.id, page: 1 }, sessionId),
      /OCR is disabled in settings/i)
    assert.equal(rendered, 0)
  } finally { await state.workspaces.dispose() }
})

test('pdf_ocr_page returns bounded positioned lines and refuses OCR from a changed document', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-ocr-stale'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  let changeDuringRecognition = false
  const { ctx, definitions } = captureTools({ ocr: {
    selectedDescriptor() { return { languages: [] } },
    async availability() { return { status: 'available' } },
    async recognize(request: { languages: string[] }) {
      assert.deepEqual(request.languages, ['auto'])
      if (changeDuringRecognition) {
        const snapshot = state.workspaces.readSnapshot(sessionId, opened.id)
        await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
          revision: snapshot.revision, operations: [{ type: 'add', annotation: {
            id: 'changed-during-ocr', page: 1, subtype: 'Text', rect: [20, 20, 30, 30],
          } }] }, agent(sessionId), signal)
      }
      return { text: 'Recognized text', status: 'complete',
        source: { backendId: 'test-ocr', backendVersion: '1' },
        blocks: [], words: [], lines: [{ id: 'line-1', text: 'Recognized text',
          box: { x0: 1, y0: 2, x1: 30, y1: 40 } }], warnings: [] }
    },
  } })
  registerPdfAgentTools(ctx, state.workspaces, {
    async renderPage(callerSession: string, id: string) {
      return { snapshot: state.workspaces.readSnapshot(callerSession, id),
        png: Buffer.from('png'), width: 100, height: 100 }
    },
    async releaseDocument() {},
  } as never, { current: () => [] })
  try {
    const first = await readTool(definitions, 'pdf_ocr_page', { documentId: opened.id, page: 1 }, sessionId) as
      { geometry: { status: string }; lines: Array<{ text: string; box: { x0: number } }> }
    assert.equal(first.geometry.status, 'complete')
    assert.deepEqual(first.lines, [{ id: 'line-1', text: 'Recognized text',
      box: { x0: 1, y0: 2, x1: 30, y1: 40 } }])
    changeDuringRecognition = true
    await assert.rejects(readTool(definitions, 'pdf_ocr_page', { documentId: opened.id, page: 1 }, sessionId),
      { code: 'pdf/stale-reader' })
  } finally { await state.workspaces.dispose() }
})

test('pdf_render_page gates on exact model image capability and stores a bounded PNG attachment', {
  skip: !existsSync(nativeExecutable),
}, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const pdfService = createPdfService(state.workspaces, { executable: nativeExecutable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-render-agent'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  let capable = false, saved = 0, stageFails = false
  const { ctx, definitions } = captureTools({
    llm: { async resolveModelInfo() { return { inputModalities: capable ? ['text', 'image'] : ['text'] } } },
    ocr: {
      selectedDescriptor() { return { id: 'test-ocr', name: 'Test OCR', version: '1', languages: ['eng'] } },
      async stageImage(request: { image: Uint8Array; sessionId: string; languages: string[] }) {
        assert.equal(request.sessionId, sessionId)
        assert.deepEqual(request.languages, ['eng'])
        if (stageFails) throw new Error('Optional OCR staging is offline')
        return 'ocrimg-test'
      },
      async availability() { return { status: 'available' } },
      async recognize(request: { image: Uint8Array; signal: AbortSignal; sessionId: string }) {
        assert.equal(request.sessionId, sessionId)
        assert.equal(request.signal, signal)
        assert.deepEqual([...request.image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        return { text: 'Recognized page text', blocks: [{ id: 'block-1', text: 'Recognized page text', box: null, confidence: null }],
          lines: [], words: [], confidence: null, status: 'complete', coverage: [], warnings: [],
          source: { backendId: 'test-ocr', backendVersion: '1' } }
      },
    },
    attachments: {
      imageLimits: { mediaTypes: ['image/png'] },
      async saveImage(input: { data: Uint8Array; mediaType: string; name: string }) {
        saved++
        assert.equal(input.mediaType, 'image/png')
        assert.deepEqual([...input.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
        const bytes = Buffer.from(input.data)
        return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: bytes.length,
          width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), name: input.name }
      },
    },
  })
  registerPdfAgentTools(ctx, state.workspaces, pdfService, { current: () => [] })
  const invoke = async (page: number) => {
    const tool = definitions.get('pdf_render_page')
    assert.ok(tool)
    return tool.execute({ documentId: opened.id, page, maxEdge: 512 }, {
      signal, agent: { session: { id: sessionId, header: {}, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) },
        options: { provider: 'test', model: 'vision' } },
    }) as Promise<Record<string, unknown>>
  }
  try {
    await assert.rejects(invoke(1), /image input|does not declare/i)
    assert.equal(saved, 0, 'text-only gate must run before render and attachment write')
    capable = true
    const result = await invoke(1)
    assert.equal(result.documentId, opened.id)
    assert.equal(result.page, 1)
    assert.equal(saved, 1)
    assert.equal(result.imageHandle, 'ocrimg-test')
    const image = result.image as { width: number; height: number; attachmentId: string }
    assert.ok(image.width <= 512 && image.height <= 512)
    assert.match(image.attachmentId, /^sha256:/)
    const blocks = definitions.get('pdf_render_page')!.output.render({ documentId: opened.id, page: 1 }, result)
    assert.equal(blocks[1]?.type, 'image')
    assert.equal(blocks[1]?.attachment?.attachmentId, image.attachmentId)
    assert.ok(!JSON.stringify(result).includes('iVBOR'), 'canonical output must not embed Base64 image bytes')
    stageFails = true
    const withoutOcr = await invoke(1)
    assert.equal(withoutOcr.imageHandle, undefined, 'optional OCR failure must not hide a usable screenshot')
    assert.ok(withoutOcr.image, 'the visual model still receives the attachment')
    capable = false
    const ocrTool = definitions.get('pdf_ocr_page')
    assert.ok(ocrTool)
    const recognized = await ocrTool.execute({ documentId: opened.id, page: 1 }, {
      signal, agent: { session: { id: sessionId, header: {}, requestHeader: () => ({ config: { provider: 'test', model: 'text-only' } }) },
        options: { provider: 'test', model: 'text-only' } },
    }) as Record<string, unknown>
    assert.equal(recognized.text, 'Recognized page text')
    assert.equal('nextOffset' in recognized, false, 'nondeterministic OCR must not advertise continuation')
    await assert.rejects(ocrTool.execute({ documentId: opened.id, page: 1, offset: 1 }, {
      signal, agent: { session: { id: sessionId, header: {} }, options: { provider: 'test', model: 'text-only' } },
    }), /unrecognized|invalid|offset/i)
    assert.deepEqual(recognized.source, { kind: 'ocr', backendId: 'test-ocr', backendVersion: '1' })
    assert.equal((recognized.geometry as { status: string }).status, 'none')
    const ocrBlocks = ocrTool.output.render({}, recognized)
    assert.deepEqual(ocrBlocks.map(block => block.type), ['text'], 'text-only OCR must not return an image block')
    capable = true
    await assert.rejects(invoke(5), (error: unknown) => (error as { code?: string }).code === 'pdf/invalid-page')
  } finally { await pdfService.dispose(); await state.workspaces.dispose() }
})

test('pdf_render_page uses a configured image backend only when explicitly requested', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-image-backend-agent'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64')
  let rendered = 0, prepared = 0, saved = 0
  let description = 'A diagram with three nodes.'
  let backendAvailable = true
  let backendKind: 'direct-image' | 'derived-text' = 'derived-text'
  const { ctx, definitions } = captureTools({
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] } } },
    imageUnderstanding: {
      async availability(requestSessionId: string) {
        assert.equal(requestSessionId, sessionId)
        return backendAvailable ? { status: 'available', kind: backendKind, backendId: 'test-backend' }
          : { status: 'unavailable', reason: 'Selected backend is disabled' }
      },
      async prepare(request: { sessionId: string; question: string; image: { data: Uint8Array } }) {
        prepared++
        assert.equal(request.sessionId, sessionId)
        assert.equal(request.question, 'What does the diagram show?')
        assert.deepEqual(request.image.data, png)
        return { kind: 'derived-text', text: description,
          provenance: { backendId: 'test-backend', mode: 'image-description', model: 'cheap-vision' },
          limitations: 'Generated visual description may omit fine details.' }
      },
    },
    attachments: {
      imageLimits: { mediaTypes: ['image/png'] },
      async saveImage() { saved++; throw new Error('A derived-text backend must not save an image attachment') },
    },
  })
  registerPdfAgentTools(ctx, state.workspaces, {
    async renderPage(requestSessionId: string, documentId: string, currentPage: number) {
      rendered++
      assert.equal(requestSessionId, sessionId)
      assert.equal(currentPage, 1)
      return { snapshot: state.workspaces.readSnapshot(requestSessionId, documentId), png, width: 1, height: 1 }
    },
    async releaseDocument() {},
  } as never, { current: () => [] })
  const args = { documentId: opened.id, page: 1, question: 'What does the diagram show?' }
  const exec = { signal, agent: { session: { id: sessionId, header: {},
    requestHeader: () => ({ config: { provider: 'test', model: 'text-only' } }) },
  options: { provider: 'test', model: 'text-only' } } }
  const tool = definitions.get('pdf_render_page')!
  try {
    await assert.rejects(tool.execute(args, exec), /does not declare image input/i)
    assert.equal(rendered, 0, 'default direct-image route rejects before rendering')
    backendAvailable = false
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, exec), /backend is disabled/i)
    assert.equal(rendered, 0, 'unavailable configured backend rejects before rendering')
    backendAvailable = true
    const derived = await tool.execute({ ...args, mode: 'configured-backend' }, exec) as Record<string, unknown>
    assert.equal(derived.kind, 'derived-text')
    assert.equal(derived.text, 'A diagram with three nodes.')
    assert.deepEqual(derived.source, { backendId: 'test-backend', mode: 'image-description', model: 'cheap-vision' })
    assert.equal(derived.limitations, 'Generated visual description may omit fine details.')
    assert.equal(rendered, 1)
    assert.equal(prepared, 1)
    assert.equal(saved, 0)
    assert.deepEqual(tool.output.render(args, derived).map(block => block.type), ['text'])
    description = 'detail '.repeat(1_500)
    const longDescription = await tool.execute({ ...args, mode: 'configured-backend' }, exec) as Record<string, unknown>
    assert.equal(longDescription.text, description, 'the bounded backend result must not be silently cut to 8000 characters')
    assert.equal(longDescription.totalChars, description.length)
    assert.equal(longDescription.truncated, false)
    backendKind = 'direct-image'
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, exec), /does not declare image input/i)
    assert.equal(rendered, 2, 'configured direct-image backend still enforces current model capability first')
    assert.equal(saved, 0)
  } finally { await state.workspaces.dispose() }
})

test('pdf_render_page checks route, backend, attachment type, and backend changes before exposing an image', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-render-boundaries'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64')
  let renders = 0
  let imageInput = true
  let preparation: 'direct-image' | 'stale' = 'direct-image'
  const services: Record<string, unknown> = {
    llm: { async resolveModelInfo() { return { inputModalities: imageInput ? ['text', 'image'] : ['text'] } } },
  }
  const { ctx, definitions } = captureTools(services)
  registerPdfAgentTools(ctx, state.workspaces, {
    async renderPage(callerSession: string, id: string) {
      renders++
      return { snapshot: state.workspaces.readSnapshot(callerSession, id), png, width: 1, height: 1 }
    },
    async releaseDocument() {},
  } as never, { current: () => [] })
  const tool = definitions.get('pdf_render_page')!
  const args = { documentId: opened.id, page: 1 }
  const routed = { signal, agent: { session: { id: sessionId,
    requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }) },
  options: { provider: 'test', model: 'vision' } } }
  const unknownRoute = { signal, agent: { session: { id: sessionId,
    requestHeader: () => ({ config: {} }) }, options: {} } }
  try {
    await assert.rejects(tool.execute(args, unknownRoute), { code: 'pdf/image-route-unknown' })
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, routed),
      { code: 'pdf/image-backend-unavailable' })
    await assert.rejects(tool.execute(args, routed), { code: 'pdf/attachment-unavailable' })
    assert.equal(renders, 0, 'preflight rejection must precede page rendering')
    services.attachments = { imageLimits: { mediaTypes: ['image/jpeg'] } }
    await assert.rejects(tool.execute(args, routed), { code: 'pdf/image-type-unsupported' })
    assert.equal(renders, 0)

    services.imageUnderstanding = {
      async availability() { return { status: 'available', kind: 'derived-text' } },
      async prepare() {
        if (preparation === 'stale') {
          const snapshot = state.workspaces.readSnapshot(sessionId, opened.id)
          await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
            revision: snapshot.revision, operations: [{ type: 'add', annotation: {
              id: 'changed-during-image-understanding', page: 1, subtype: 'Text', rect: [20, 20, 30, 30],
            } }] }, agent(sessionId), signal)
          return { kind: 'derived-text', text: 'No longer current', provenance: { backendId: 'test' } }
        }
        return { kind: 'direct-image' }
      },
    }
    delete services.attachments
    imageInput = false
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, routed),
      { code: 'pdf/image-input-unsupported' })
    imageInput = true
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, routed),
      { code: 'pdf/attachment-unavailable' })
    services.attachments = { imageLimits: { mediaTypes: [] } }
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, routed),
      { code: 'pdf/image-type-unsupported' })
    preparation = 'stale'
    await assert.rejects(tool.execute({ ...args, mode: 'configured-backend' }, routed),
      { code: 'pdf/stale-reader' })
    assert.equal(renders, 4, 'only post-render checks should render a page')
  } finally { await state.workspaces.dispose() }
})

test('pdf_read_page reads only a caller-owned working copy, reports no text, and refuses anonymous access', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const alice = 'pdf-agent-alice', bob = 'pdf-agent-bob'
  const opened = await state.workspaces.execute(alice, {
    action: 'open', sessionId: alice,
    address: `dsh-resource://file/session/${alice}//fixtures/native.pdf`,
  }, agent(alice), signal)
  assert.ok('bytes' in opened)

  const nativeCalls: Array<{ sessionId: string; page: number }> = []
  const pdfService = {
    async readPageText(sessionId: string, documentId: string, page: number, readSignal: AbortSignal) {
      readSignal.throwIfAborted()
      const snapshot = state.workspaces.readSnapshot(sessionId, documentId)
      if (page > snapshot.document.pageCount) throw new Error('Page is outside the document')
      nativeCalls.push({ sessionId, page })
      const content = { items: page === 2 ? [] : [{
        str: 'Native PDF test page 1', transform: [1, 0, 0, 1, 0, 0], width: 100, height: 10,
        dir: 'ltr', fontName: 'Helvetica', hasEOL: false,
      }], styles: {}, lang: null }
      return { snapshot, content }
    },
  }
  const readerContexts = createReaderContexts(state.workspaces)
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, pdfService as never, readerContexts)
  try {
    const page = await readTool(definitions, 'pdf_read_page', { documentId: opened.id, page: 1 }, alice) as Record<string, unknown>
    assert.equal(page.status, 'ok')
    assert.equal(page.documentId, opened.id)
    assert.equal(page.page, 1)
    assert.equal(page.pageCount, 4)
    assert.equal(page.revision, opened.revision)
    assert.equal(page.contentVersion, opened.contentVersion)
    assert.equal(page.path, opened.path)
    assert.match(String(page.text), /Native PDF test page 1/)
    assert.equal(page.nextOffset, null)
    assert.equal(page.truncated, false)

    const blank = await readTool(definitions, 'pdf_read_page', { documentId: opened.id, page: 2 }, alice) as Record<string, unknown>
    assert.equal(blank.status, 'no_text')
    assert.equal(blank.text, '')
    assert.equal(blank.nextOffset, null)
    assert.equal(blank.totalChars, 0)

    const priorCalls = nativeCalls.length
    await assert.rejects(readTool(definitions, 'pdf_read_page', {
      documentId: opened.id, page: 1, sessionId: alice,
    }, bob), /session|belong|access/i)
    await assert.rejects(readTool(definitions, 'pdf_read_page', { documentId: opened.id, page: 1 }), /agent|session|access/i)
    await assert.rejects(readTool(definitions, 'pdf_read_page', { documentId: opened.id, page: 5 }, alice), /page|range/i)
    assert.equal(nativeCalls.length, priorCalls, 'unauthorized calls must not reach PDFium')
  } finally {
    readerContexts.dispose()
    await state.workspaces.dispose()
  }
})

test('pdf_read_page rejects a snapshot invalidated during native extraction', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-read-stale'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, {
    ...state.workspaces,
    readSnapshot(id: string, documentId: string) {
      const current = state.workspaces.readSnapshot(id, documentId)
      return { ...current, revision: current.revision + 1 }
    },
  }, {
    async readPageText(id: string, documentId: string) {
      return { snapshot: state.workspaces.readSnapshot(id, documentId),
        content: { items: [], styles: {}, lang: null } }
    },
  } as never, { current: () => [] })
  try {
    await assert.rejects(readTool(definitions, 'pdf_read_page', { documentId: opened.id, page: 1 }, sessionId),
      { code: 'pdf/stale-reader' })
  } finally { await state.workspaces.dispose() }
})

test('pdf_current exposes only fresh reader hints from the caller session', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-current-owner'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  let now = 0
  const readerContexts = createReaderContexts(state.workspaces, 90, () => now)
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, {} as never, readerContexts)
  try {
    const initial = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(initial.status, 'none')
    assert.deepEqual(initial.documents, [])

    readerContexts.update(sessionId, {
      action: 'set', sessionId, tabId: 'reader-a', leaseId: 'lease-a', sequence: 1,
      documentId: opened.id, contentVersion: opened.contentVersion, page: 3,
    })
    const active = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(active.status, 'active')
    assert.deepEqual(active.documents, [{
      documentId: opened.id, path: opened.path, page: 3, pageCount: 4,
      revision: opened.revision, contentVersion: opened.contentVersion,
    }])
    const otherSession = await readTool(definitions, 'pdf_current', {}, 'pdf-current-other') as Record<string, unknown>
    assert.equal(otherSession.status, 'none')
    assert.deepEqual(otherSession.documents, [])

    readerContexts.update(sessionId, {
      action: 'set', sessionId, tabId: 'reader-b', leaseId: 'lease-b', sequence: 2,
      documentId: opened.id, contentVersion: opened.contentVersion, page: 4,
    })
    const ambiguous = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(ambiguous.status, 'multiple')
    assert.equal((ambiguous.documents as unknown[]).length, 2)

    readerContexts.update(sessionId, {
      action: 'clear', sessionId, tabId: 'reader-b', leaseId: 'lease-b', sequence: 3,
    })
    const oneAgain = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(oneAgain.status, 'active')

    readerContexts.update(sessionId, {
      action: 'clear', sessionId, tabId: 'reader-a', leaseId: 'lease-a', sequence: 4,
    })
    const cleared = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(cleared.status, 'none')
    assert.deepEqual(cleared.documents, [])

    // A different tab's higher-sequence clear must not suppress this tab's
    // independently ordered update when RPC replies arrive out of order.
    readerContexts.update(sessionId, {
      action: 'clear', sessionId, tabId: 'reader-a', leaseId: 'lease-a', sequence: 12,
    })
    readerContexts.update(sessionId, {
      action: 'set', sessionId, tabId: 'reader-b', leaseId: 'lease-b2', sequence: 11,
      documentId: opened.id, contentVersion: opened.contentVersion, page: 4,
    })
    const stillVisible = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(stillVisible.status, 'active')
    readerContexts.update(sessionId, {
      action: 'clear', sessionId, tabId: 'reader-b', leaseId: 'lease-b2', sequence: 13,
    })

    readerContexts.update(sessionId, {
      action: 'set', sessionId, tabId: 'reader-a', leaseId: 'lease-a', sequence: 14,
      documentId: opened.id, contentVersion: opened.contentVersion, page: 2,
    })
    now = 91
    const expired = await readTool(definitions, 'pdf_current', {}, sessionId) as Record<string, unknown>
    assert.equal(expired.status, 'none')
    assert.deepEqual(expired.documents, [])
  } finally {
    readerContexts.dispose()
    await state.workspaces.dispose()
  }
})

test('pdf_search returns bounded hits and a cursor that resumes without duplicates', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-search-owner'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const pageText = 'needle '.repeat(25)
  let staleRead = false
  const pdfService = {
    async readPageText(callerSession: string, documentId: string, page: number, readSignal: AbortSignal) {
      readSignal.throwIfAborted()
      const snapshot = state.workspaces.readSnapshot(callerSession, documentId)
      return { snapshot: staleRead ? { ...snapshot, revision: snapshot.revision + 1 } : snapshot,
        content: { items: page === 1 ? [{
        str: pageText, transform: [1, 0, 0, 1, 0, 0], width: 100, height: 10,
        dir: 'ltr', fontName: 'Helvetica', hasEOL: false,
      }] : [], styles: {}, lang: null } }
    },
  }
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, pdfService as never, { current: () => [] })
  try {
    const first = await readTool(definitions, 'pdf_search', {
      documentId: opened.id, query: 'needle',
    }, sessionId) as { matches: { page: number; offset: number }[]; nextCursor: { page: number; offset: number } | null }
    assert.equal(first.matches.length, 20)
    assert.ok(first.nextCursor)
    assert.equal(first.nextCursor.page, 1)

    const second = await readTool(definitions, 'pdf_search', {
      documentId: opened.id, query: 'needle', fromPage: first.nextCursor.page,
      offset: first.nextCursor.offset,
    }, sessionId) as typeof first
    assert.equal(second.matches.length, 5)
    assert.equal(second.nextCursor, null)
    const offsets = [...first.matches, ...second.matches].map(match => match.offset)
    assert.deepEqual(offsets, Array.from({ length: 25 }, (_, index) => index * 7))
    await assert.rejects(readTool(definitions, 'pdf_search', {
      documentId: opened.id, query: 'needle', fromPage: 5,
    }, sessionId), { code: 'pdf/invalid-page' })
    staleRead = true
    await assert.rejects(readTool(definitions, 'pdf_search', {
      documentId: opened.id, query: 'needle',
    }, sessionId), { code: 'pdf/stale-reader' })
  } finally {
    await state.workspaces.dispose()
  }
})

test('pdf_read_page retrieves actual PDFium text through the Host service', {
  skip: !existsSync(nativeExecutable),
}, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const pdfService = createPdfService(state.workspaces, { executable: nativeExecutable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-native-agent'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, pdfService, { current: () => [] })
  try {
    const result = await readTool(definitions, 'pdf_read_page', {
      documentId: opened.id, page: 1,
    }, sessionId) as Record<string, unknown>
    assert.equal(result.status, 'ok')
    assert.equal(result.text, 'Native PDF test page 1')
    assert.equal(result.documentId, opened.id)
    assert.equal(result.page, 1)
  } finally {
    await pdfService.dispose()
    await state.workspaces.dispose()
  }
})

test('pdf_page_annotations ignores navigation entries and never reads text for a page without marks', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const { ctx, definitions } = captureTools()
  let textReads = 0
  registerPdfAgentTools(ctx, state.workspaces,
    { async readPageText() { textReads++; throw new Error('a page without text marks must not read page text') },
      async releaseDocument() {} } as never,
    { current: () => [] })
  const sessionId = 'pdf-annotations-links'
  try {
    // Every fixture page carries two Link annotations, which are navigation.
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
    assert.ok('bytes' in opened)
    const linksOnly = await readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 1 }, sessionId) as Record<string, unknown>
    assert.equal(linksOnly.total, 0)
    assert.deepEqual(linksOnly.annotations, [])
    assert.equal(linksOnly.nextCursor, null)
    assert.equal(linksOnly.pageCount, 4)
    assert.equal(textReads, 0)

    // A note carries no covered text, so adding one must not start a text read
    // either: only marks with quadrilaterals pay for that.
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, operations: [{ type: 'add', annotation: { id: 'note-only', page: 1,
        subtype: 'Text', rect: [60, 200, 80, 220], color: [1, 0.85, 0], contents: 'A note' } }] },
      agent(sessionId), signal)
    const withNote = await readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 1 }, sessionId) as
      { total: number; annotations: Record<string, unknown>[] }
    assert.equal(withNote.total, 1)
    assert.equal(withNote.annotations[0]!.subtype, 'Text')
    assert.equal(withNote.annotations[0]!.draft, true)
    assert.equal(textReads, 0)
  } finally {
    await state.workspaces.dispose()
  }
})

test('pdf_page_annotations rejects a result when an annotation changes during its text read', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-annotations-race'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const added = await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
    revision: opened.revision, operations: [{ type: 'add', annotation: {
      id: 'racing-highlight', page: 1, subtype: 'Highlight', rect: [42, 320, 170, 342],
      quadPoints: [42, 342, 170, 342, 42, 320, 170, 320], contents: 'Original comment',
    } }] }, agent(sessionId), signal)
  assert.ok('bytes' in added)
  const beforeRead = state.workspaces.readSnapshot(sessionId, opened.id)
  let enterRead!: () => void
  let finishRead!: () => void
  const readStarted = new Promise<void>(resolve => { enterRead = resolve })
  const readReleased = new Promise<void>(resolve => { finishRead = resolve })
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, {
    async readPageText() {
      enterRead()
      await readReleased
      return { snapshot: beforeRead, content: { items: [], styles: {}, lang: null } }
    },
    async releaseDocument() {},
  } as never, { current: () => [] })
  try {
    const pending = readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 1 }, sessionId)
    await readStarted
    const latest = state.workspaces.readSnapshot(sessionId, opened.id)
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: latest.revision, operations: [{ type: 'update', id: 'racing-highlight',
        patch: { contents: 'Updated while readPageText was pending' } }] }, agent(sessionId), signal)
    finishRead()
    await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === 'pdf/stale-reader')
  } finally {
    finishRead()
    await state.workspaces.dispose()
  }
})

test('pdf_page_annotations refuses text extracted from a different revision', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-annotations-extraction-stale'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
    revision: opened.revision, operations: [{ type: 'add', annotation: {
      id: 'highlight', page: 1, subtype: 'Highlight', rect: [42, 320, 170, 342],
      quadPoints: [42, 342, 170, 342, 42, 320, 170, 320],
    } }] }, agent(sessionId), signal)
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, {
    async readPageText(callerSession: string, id: string) {
      const snapshot = state.workspaces.readSnapshot(callerSession, id)
      return { snapshot: { ...snapshot, revision: snapshot.revision + 1 },
        content: { items: [], styles: {}, lang: null } }
    },
    async releaseDocument() {},
  } as never, { current: () => [] })
  try {
    await assert.rejects(readTool(definitions, 'pdf_page_annotations', {
      documentId: opened.id, page: 1,
    }, sessionId), { code: 'pdf/stale-reader' })
  } finally { await state.workspaces.dispose() }
})

test('pdf_page_annotations rejects an offset cursor from an earlier annotation revision', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-annotations-cursor'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const note = (id: string) => ({ id, page: 1, subtype: 'Text' as const,
    rect: [60, 200, 80, 220] as [number, number, number, number], contents: id })
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces,
    { async readPageText() { throw new Error('Text notes must not trigger a text read') }, async releaseDocument() {} } as never,
    { current: () => [] })
  try {
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, operations: [{ type: 'add', annotation: note('a-note') },
        { type: 'add', annotation: note('b-note') }] }, agent(sessionId), signal)
    const first = await readTool(definitions, 'pdf_page_annotations', {
      documentId: opened.id, page: 1, limit: 1,
    }, sessionId) as { annotations: { id: string }[]; nextCursor: unknown }
    assert.deepEqual(first.annotations.map(item => item.id), ['a-note'])
    assert.notEqual(first.nextCursor, null)
    await assert.rejects(readTool(definitions, 'pdf_page_annotations', {
      documentId: opened.id, page: 1, cursor: 'not-a-canonical-cursor',
    }, sessionId), { code: 'pdf/invalid-window' })
    const beforeEdit = state.workspaces.readSnapshot(sessionId, opened.id)
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: beforeEdit.revision, operations: [{ type: 'add', annotation: note('0-note') }] }, agent(sessionId), signal)
    // A bare offset of 1 would now return a-note twice. The continuation must
    // be tied to the revision that produced it and refused after the edit.
    await assert.rejects(readTool(definitions, 'pdf_page_annotations', {
      documentId: opened.id, page: 1, cursor: first.nextCursor, limit: 1,
    }, sessionId), (error: unknown) => (error as { code?: string }).code === 'pdf/stale-reader')
  } finally {
    await state.workspaces.dispose()
  }
})

test('pdf_page_annotations bounds long document metadata without losing pagination', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-annotations-output-budget'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces,
    { async readPageText() { throw new Error('Text notes must not trigger a text read') }, async releaseDocument() {} } as never,
    { current: () => [] })
  try {
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, operations: Array.from({ length: 50 }, (_, index) => ({ type: 'add' as const,
        annotation: { id: `note-${String(index).padStart(2, '0')}-${'I'.repeat(190)}`,
          page: 1, subtype: 'Text' as const, rect: [60, 200, 80, 220] as [number, number, number, number],
          contents: 'C'.repeat(4000), author: 'A'.repeat(1024) } })) }, agent(sessionId), signal)

    const seen = new Set<string>()
    let cursor: unknown
    for (let request = 0; request < 50; request++) {
      const result = await readTool(definitions, 'pdf_page_annotations', {
        documentId: opened.id, page: 1, limit: 50,
        ...(cursor === undefined ? {} : { cursor }),
      }, sessionId) as { total: number; annotations: Array<{ id: string; author?: string; contents?: string }>; nextCursor: unknown }
      assert.equal(result.total, 50)
      assert.ok(JSON.stringify(result).length <= 32_768, 'one tool response must fit its total character budget')
      assert.ok(result.annotations.length > 0, 'a bounded page must still make progress')
      for (const annotation of result.annotations) {
        assert.ok(!seen.has(annotation.id), 'continuation must not repeat an annotation')
        seen.add(annotation.id)
        assert.ok((annotation.author?.length ?? 0) < 1024, 'untrusted author metadata must be clipped')
        assert.ok((annotation.contents?.length ?? 0) < 4000, 'untrusted comments must be clipped')
      }
      if (result.nextCursor === null) break
      cursor = result.nextCursor
    }
    assert.equal(seen.size, 50, 'all annotations remain reachable through pagination')
  } finally {
    await state.workspaces.dispose()
  }
})

test('pdf_page_annotations reports page markup with covered text, draft state and pagination', {
  skip: !existsSync(nativeExecutable),
}, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const pdfService = createPdfService(state.workspaces, { executable: nativeExecutable, subprocess: nativeTestSubprocess })
  const sessionId = 'pdf-annotations-page'
  const { ctx, definitions } = captureTools()
  registerPdfAgentTools(ctx, state.workspaces, pdfService, { current: () => [] })
  try {
    const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
    assert.ok('bytes' in opened)
    // Take the quadrilateral from the page's own text run, so the covered-text
    // expectation is derived from the file rather than guessed.
    const read = await pdfService.readPageText(sessionId, opened.id, 1, signal)
    const run = read.content.items.find(item => item.str.includes('Native PDF test page 1'))
    assert.ok(run, 'the fixture page keeps its text run')
    const [a, b, , , x, y] = run.transform
    assert.equal(Math.hypot(a, b) > 0, true)
    const top = y + run.height * 0.8, bottom = y - run.height * 0.2, right = x + run.width
    const highlight = { id: 'probe-highlight', page: 1, subtype: 'Highlight',
      rect: [x, bottom, right, top],
      quadPoints: [x, top, right, top, x, bottom, right, bottom], color: [1, 0, 0] }
    const note = { id: 'probe-note', page: 1, subtype: 'Text', rect: [60, 200, 80, 220],
      color: [1, 0.85, 0], contents: 'Comment kept in the file' }
    await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
      revision: opened.revision, operations: [{ type: 'add', annotation: highlight }, { type: 'add', annotation: note }] },
      agent(sessionId), signal)

    const result = await readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 1 }, sessionId) as
      { total: number; nextCursor: string | null; annotations: Record<string, unknown>[] }
    // Links are excluded; only the two marks added above remain.
    assert.equal(result.total, 2)
    assert.deepEqual(result.annotations.map(annotation => annotation.subtype), ['Highlight', 'Text'])
    const [mark, sticky] = result.annotations
    assert.equal(mark.draft, true, 'unsaved additions are marked as drafts')
    assert.deepEqual(mark.color, [255, 0, 0])
    assert.match(String(mark.excerpt), /Native PDF test page 1/)
    assert.equal(sticky.contents, 'Comment kept in the file')

    const first = await readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 1, limit: 1 }, sessionId) as
      { annotations: Record<string, unknown>[]; nextCursor: string | null }
    assert.equal(first.annotations.length, 1)
    assert.equal(typeof first.nextCursor, 'string')
    const second = await readTool(definitions, 'pdf_page_annotations', {
      documentId: opened.id, page: 1, cursor: first.nextCursor, limit: 1,
    }, sessionId) as { annotations: Record<string, unknown>[]; nextCursor: string | null }
    assert.equal(second.annotations[0]!.id, 'probe-note')
    assert.equal(second.nextCursor, null)
    await assert.rejects(readTool(definitions, 'pdf_page_annotations', {
      documentId: opened.id, page: 1, cursor: 1,
    }, sessionId), /string|cursor/i)

    // An empty page still answers, and a page outside the document is refused.
    const empty = await readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 4 }, sessionId) as Record<string, unknown>
    assert.equal(empty.total, 0)
    await assert.rejects(readTool(definitions, 'pdf_page_annotations', { documentId: opened.id, page: 5 }, sessionId),
      /outside the document/)
  } finally {
    await pdfService.dispose()
    await state.workspaces.dispose()
  }
})
