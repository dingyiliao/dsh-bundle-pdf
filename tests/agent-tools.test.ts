import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerPdfAgentTools, windowPageText } from '../src/host/agent-tools.ts'
import { createPdfService } from '../src/host/pdf-service.ts'
import { createReaderContexts } from '../src/host/reader-contexts.ts'
import { memoryWorkspace, nativeFixture } from './native-fixture.ts'

interface CapturedTool {
  execute(args: unknown, exec: unknown): Promise<unknown>
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

function captureTools() {
  const definitions = new Map<string, CapturedTool>()
  const ctx = {
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
