import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerPdfAgentTools, summarizeOutline, windowPageText } from '../src/host/agent-tools.ts'
import { createBookmarkService, type BookmarkRecord } from '../src/host/bookmarks.ts'
import { createPdfService } from '../src/host/pdf-service.ts'
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

test('pdf_render_page gates on exact model image capability and stores a bounded PNG attachment', {
  skip: !existsSync(nativeExecutable),
}, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const pdfService = createPdfService(state.workspaces, { executable: nativeExecutable })
  const sessionId = 'pdf-render-agent'
  const opened = await state.workspaces.execute(sessionId, {
    action: 'open', sessionId, address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf`,
  }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  let capable = false, saved = 0
  const { ctx, definitions } = captureTools({
    llm: { async resolveModelInfo() { return { inputModalities: capable ? ['text', 'image'] : ['text'] } } },
    ocr: {
      selectedDescriptor() { return { id: 'test-ocr', name: 'Test OCR', version: '1', languages: ['eng'] } },
      async stageImage(request: { image: Uint8Array; sessionId: string; languages: string[] }) {
        assert.equal(request.sessionId, sessionId)
        assert.deepEqual(request.languages, ['eng'])
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
  } finally { pdfService.dispose(); await state.workspaces.dispose() }
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
  const pdfService = {
    async readPageText(callerSession: string, documentId: string, page: number, readSignal: AbortSignal) {
      readSignal.throwIfAborted()
      const snapshot = state.workspaces.readSnapshot(callerSession, documentId)
      return { snapshot, content: { items: page === 1 ? [{
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
  } finally {
    await state.workspaces.dispose()
  }
})

test('pdf_read_page retrieves actual PDFium text through the Host service', {
  skip: !existsSync(nativeExecutable),
}, async () => {
  const state = memoryWorkspace(await nativeFixture())
  const pdfService = createPdfService(state.workspaces, { executable: nativeExecutable })
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
    pdfService.dispose()
    await state.workspaces.dispose()
  }
})
