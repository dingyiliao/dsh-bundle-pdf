import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerPdfAgentTools } from '../../../../src/adapters/host/dsh/index.ts'
import { questionDetail } from '../../../../src/adapters/host/dsh/model-write-tools.ts'
import { registerPdfModelBookmarkTools } from '../../../../src/adapters/host/dsh/model-bookmark-tools.ts'
import { createV1NavigationStore } from '../../../../src/adapters/host/storage/v1-navigation.ts'
import { summarizeOutline, createBookmarks, type BookmarkRecord } from '../../../../src/modules/navigation/index.ts'
import { evidenceSha256, windowPageText, type EvidenceReferenceStore } from '../../../../src/modules/evidence/index.ts'
import { createPdfService } from '../../../../src/adapters/host/pdfium/index.ts'
import { nativeTestSubprocess } from '../../../native-test-subprocess.ts'
import { createReaderContexts } from '../../../../src/modules/navigation/index.ts'
import { memoryWorkspace, nativeFixture } from '../../../native-fixture.ts'

interface CapturedTool {
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; attachment?: { attachmentId: string } }>
    presentationMeta?(args: unknown, value: unknown): unknown }
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

test('runtime session detach retains durable evidence references', async () => {
  const { ctx } = captureTools()
  let onDisposed: ((session: { id: string }) => void) | undefined
  ctx.on = ((_event: string, handler: (session: { id: string }) => void) => {
    onDisposed = handler
    return () => {}
  }) as typeof ctx.on
  const deleted: string[] = []
  const references: EvidenceReferenceStore = {
    get: () => undefined,
    async put() {},
    async delete() {},
    async deleteSession(sessionId) { deleted.push(sessionId) },
  }
  const dispose = registerPdfAgentTools(ctx, {} as never, {} as never, { current: () => [] }, undefined, references)
  assert.ok(onDisposed)
  onDisposed({ id: 'disposed-session' })
  await dispose()
  assert.deepEqual(deleted, [], 'detaching a session is not a durable deletion')
})

test('image-context replay requires a fresh-source adapter', async () => {
  const { ctx, definitions } = captureTools()
  const dispose = registerPdfAgentTools(ctx, {} as never, {} as never, { current: () => [] })
  try {
    await assert.rejects(readTool(definitions, 'pdf_image_context', {
      documentId: 'doc', refId: 'pdfref_00000000-0000-4000-8000-000000000000',
    }, 'session-a'), { code: 'pdf/source-unavailable' })
  } finally { await dispose() }
})

test('pdf_navigate forwards only a validated same-session target to the visible-Reader handoff', async () => {
  const { ctx, definitions } = captureTools()
  const forwarded: Array<{ sessionId: string; documentId: string; page: number; contentVersion: string }> = []
  const navigation = { async navigate(sessionId: string, input: { documentId: string; page: number;
    contentVersion: string }) {
    forwarded.push({ sessionId, ...input })
    return { status: 'opened' as const, requestId: 'request-1', page: input.page, reason: null, tabIds: [] }
  } }
  const dispose = registerPdfAgentTools(ctx, {} as never, {} as never, { current: () => [] }, undefined,
    undefined, undefined, navigation as never)
  try {
    const result = await readTool(definitions, 'pdf_navigate', {
      documentId: 'doc-1', page: 3, contentVersion: 'version-1',
    }, 'session-1') as { status: string }
    assert.equal(result.status, 'opened')
    assert.deepEqual(forwarded, [{ sessionId: 'session-1', documentId: 'doc-1', page: 3,
      contentVersion: 'version-1' }])
    await assert.rejects(readTool(definitions, 'pdf_navigate', {
      documentId: 'doc-1', page: 0, contentVersion: 'version-1',
    }, 'session-1'))
    await assert.rejects(readTool(definitions, 'pdf_navigate', {
      documentId: 'doc-1', page: 3, contentVersion: 'version-1',
    }), /session/i)
    assert.equal(forwarded.length, 1)
  } finally { await dispose() }
})

test('model annotation updates the draft immediately; only PDF save requires a reviewed human answer', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-model-tool-review'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const decisions: string[] = []
  const services: Record<string, unknown> = {}
  const { ctx, definitions } = captureTools(services)
  const quote = 'MMFAR title'
  const pages = { async readPageText() { return { snapshot: state.workspaces.readSnapshot(sessionId, opened.id), content: {
    items: [{ str: quote, transform: [12, 0, 0, 12, 60, 90], width: quote.length * 6, height: 12,
      dir: 'ltr', fontName: 'test', hasEOL: false,
      glyphs: Array.from(quote, (_, index) => [60 + index * 6, 90, 6] as [number, number, number]) }],
    styles: { test: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } }, lang: null,
  } } } }
  const dispose = registerPdfAgentTools(ctx, state.workspaces, pages as never, { current: () => [] })
  try {
    const args = { documentId: opened.id, expectedRevision: opened.revision,
      subtype: 'Highlight', target: { kind: 'pdf-text', page: 1, quote },
      color: [1, 1, 0], comment: 'Look here' }
    await assert.rejects(readTool(definitions, 'pdf_annotate', { ...args, confirmed: true }, sessionId),
      /unrecognized|confirmed|invalid/i)
    const updated = await readTool(definitions, 'pdf_annotate', args, sessionId) as {
      status: string; revision: number; dirty: boolean; canUndo: boolean; annotationId: string
    }
    assert.equal(updated.status, 'updated')
    assert.equal(updated.dirty, true)
    assert.equal(updated.canUndo, true)
    assert.ok(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations.some(item => item.id === updated.annotationId))
    const ranged = await readTool(definitions, 'pdf_annotate', {
      ...args, expectedRevision: updated.revision,
      target: { kind: 'pdf-text-range', start: { page: 1, quote }, end: { page: 1, quote } },
    }, sessionId) as { status: string; revision: number; coverage: { pages: Array<{ action: string }> } }
    assert.equal(ranged.status, 'already_annotated')
    assert.equal(ranged.revision, updated.revision)
    assert.equal(ranged.coverage.pages[0]?.action, 'existing')
    assert.equal(decisions.length, 0, 'draft edits do not ask for approval')
    assert.equal(state.writes(), 0)
    await assert.rejects(readTool(definitions, 'pdf_save', {
      documentId: opened.id, expectedRevision: updated.revision, confirmed: true,
    }, sessionId), /unrecognized|confirmed|invalid/i)
    await assert.rejects(readTool(definitions, 'pdf_save', {
      documentId: opened.id, expectedRevision: updated.revision,
    }, sessionId), { code: 'pdf/approval-unavailable' })
    services.userQuestions = { async ask(request: { questions: Array<{ id: string; options: Array<{ label: string }> }> }) {
      const question = request.questions[0]!
      return { answers: [{ id: question.id, selected: [question.options[0]!.label], custom: 'model spoof' }] }
    } }
    await assert.rejects(readTool(definitions, 'pdf_save', {
      documentId: opened.id, expectedRevision: updated.revision,
    }, sessionId), { code: 'pdf/approval-rejected' })
    assert.equal(state.writes(), 0)
    services.userQuestions = { async ask(request: { questions: Array<{ id: string; detail: string;
      options: Array<{ label: string }> }> }) {
      const question = request.questions[0]!
      decisions.push(question.detail)
      return { answers: [{ id: question.id, selected: [question.options[0]!.label] }] }
    } }
    const saved = await readTool(definitions, 'pdf_save', {
      documentId: opened.id, expectedRevision: updated.revision,
    }, sessionId) as { status: string; dirty: boolean }
    assert.equal(saved.status, 'saved')
    assert.equal(saved.dirty, false)
    assert.equal(state.writes(), 1)
    assert.match(decisions.at(-1)!, /覆盖保存到原 PDF 文件/)
    assert.match(decisions.at(-1)!, /将保存的最终批注变化/)
    assert.match(decisions.at(-1)!, /Look here/)
  } finally { await dispose(); await state.workspaces.dispose() }
})

test('model sees exact comment reply IDs and edits or deletes them before their parent mark', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-model-existing-annotations'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
    id: opened.id, revision: opened.revision, operations: [
      { type: 'add', annotation: { id: 'parent-mark', page: 1, subtype: 'Highlight',
        rect: [60, 80, 120, 100], quadPoints: [60, 100, 120, 100, 60, 80, 120, 80],
        contents: 'Original comment' } },
      { type: 'add', annotation: { id: 'reply-comment', page: 1, subtype: 'Text',
        rect: [60, 80, 90, 100], replyToId: 'parent-mark', contents: 'Original reply' } },
    ] }, agent(sessionId), signal)
  assert.ok('bytes' in changed)
  const pages = { async readPageText() { return { snapshot: state.workspaces.readSnapshot(sessionId, opened.id),
    content: { items: [], styles: {}, lang: null } } } }
  const { ctx, definitions } = captureTools()
  const dispose = registerPdfAgentTools(ctx, state.workspaces, pages as never, { current: () => [] })
  try {
    const listed = await readTool(definitions, 'pdf_page_annotations', { documentId: opened.id,
      page: 1 }, sessionId) as { revision: number; annotations: Array<{ id: string; replyToId?: string }> }
    assert.equal(listed.annotations.find(item => item.id === 'reply-comment')?.replyToId, 'parent-mark')
    await assert.rejects(readTool(definitions, 'pdf_annotation_delete', { documentId: opened.id,
      expectedRevision: listed.revision, annotationId: 'parent-mark' }, sessionId), /repl|parent/i)
    const reply = await readTool(definitions, 'pdf_annotation_update', { documentId: opened.id,
      expectedRevision: listed.revision, annotationId: 'reply-comment', comment: 'Revised reply' },
    sessionId) as { revision: number; savedToFile: boolean }
    assert.equal(reply.savedToFile, false)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations
      .find(item => item.id === 'reply-comment')?.contents, 'Revised reply')
    const deletedReply = await readTool(definitions, 'pdf_annotation_delete', { documentId: opened.id,
      expectedRevision: reply.revision, annotationId: 'reply-comment' }, sessionId) as { revision: number }
    const deletedParent = await readTool(definitions, 'pdf_annotation_delete', { documentId: opened.id,
      expectedRevision: deletedReply.revision, annotationId: 'parent-mark' }, sessionId) as { status: string }
    assert.equal(deletedParent.status, 'deleted')
    assert.equal(state.writes(), 0)
  } finally { await dispose(); await state.workspaces.dispose() }
})

test('save approval details present ordinary values compactly without exposing internal IDs', () => {
  const detail = questionDetail({ kind: 'save', documentId: 'internal-document-id',
    path: '/fixtures/native.pdf', revision: 1, dirty: true, saveChangeCount: 1,
    saveDiffText: 'Look here' })
  assert.match(detail, /` \/fixtures\/native\.pdf `/)
  assert.match(detail, /Look here/)
  assert.doesNotMatch(detail, /代码块|internal-document-id/)
})

test('Markdown approval details keep hostile path and save diff inside inert code fences', () => {
  const attack = '\n````\n![beacon](https://evil.example/track)\n[click](https://evil.example/link)\n'
  const save = questionDetail({ kind: 'save', documentId: `doc${attack}`,
    path: `/tmp/document${attack}.pdf`, revision: 1, dirty: true,
    saveChangeCount: 1, saveDiffText: `评论：∅ → ${JSON.stringify(attack)}` })
  for (const detail of [save]) {
    const blocks = [...detail.matchAll(/(`{3,})\n([\s\S]*?)\n\1/g)]
    assert.ok(blocks.length >= 2, 'multiline document content is rendered as fenced code')
    assert.ok(blocks.some(block => block[2]!.includes('![beacon]')))
    assert.ok(blocks.some(block => block[1]!.length > 4), 'an embedded fence cannot close its wrapper')
    const outside = detail.replace(/(`{3,})\n[\s\S]*?\n\1/g, '')
    assert.doesNotMatch(outside, /!\[beacon\]|\[click\]\(https:\/\//)
    assert.doesNotMatch(outside, /evil\.example/)
  }
})

test('one-line document values with backticks remain in an inert code span', () => {
  const injected = '`![beacon](https://evil.example/track)'
  const detail = questionDetail({ kind: 'save', documentId: 'internal',
    path: `/tmp/${injected}.pdf`, revision: 1, dirty: true,
    saveChangeCount: 1, saveDiffText: 'ordinary diff' })
  assert.match(detail, /`` \/tmp\/`!\[beacon\]\(https:\/\/evil\.example\/track\)\.pdf ``/)
  assert.match(detail, /ordinary diff/)
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
  const bookmarks = createBookmarks(state.workspaces, createV1NavigationStore({
    get: key => rows.get(key), async put(key, value) { rows.set(key, value) }, async delete(key) { rows.delete(key) },
  }))
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

test('model bookmark tools add, rename and approve removal through the Reader bookmark store', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-bookmark-edit'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const originalBytes = state.current().slice()
  const rows = new Map<string, BookmarkRecord>()
  const bookmarks = createBookmarks(state.workspaces, createV1NavigationStore({
    get: key => rows.get(key), async put(key, value) { rows.set(key, value) }, async delete(key) { rows.delete(key) },
  }))
  const services: Record<string, unknown> = {}
  const { ctx, definitions } = captureTools(services)
  registerPdfAgentTools(ctx, state.workspaces, { async readOutline(callerSession: string, id: string) {
    return { snapshot: state.workspaces.readSnapshot(callerSession, id), items: [] }
  } } as never, { current: () => [] }, bookmarks)
  try {
    const added = await readTool(definitions, 'pdf_bookmark_add', { documentId: opened.id,
      expectedRevision: opened.revision, title: 'Read this', target: { kind: 'page', page: 2 } },
    sessionId) as { bookmarkId: string; updatedAt: string; savedToPdf: boolean }
    assert.match(added.bookmarkId, /^[\da-f-]{36}$/i)
    assert.equal(added.savedToPdf, false)
    assert.equal(state.writes(), 0)
    assert.deepEqual(state.current(), originalBytes)
    const listed = await readTool(definitions, 'pdf_bookmarks', { documentId: opened.id,
      kind: 'personal' }, sessionId) as { entries: Array<{ key: string; updatedAt: string; page: number }> }
    assert.deepEqual(listed.entries, [{ kind: 'personal', key: added.bookmarkId, title: 'Read this',
      page: 2, depth: 1, children: 0, stale: 'none', updatedAt: added.updatedAt }])
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, false)
    await assert.rejects(readTool(definitions, 'pdf_bookmark_add', { documentId: opened.id,
      expectedRevision: opened.revision, title: 'Wrong page', target: { kind: 'page', page: 99 } }, sessionId),
    { code: 'pdf/invalid-page' })
    await assert.rejects(readTool(definitions, 'pdf_bookmark_add', { documentId: opened.id,
      expectedRevision: opened.revision, title: 'Wrong ID',
      target: { kind: 'annotation', annotationId: 'unknown' } }, sessionId),
    { code: 'pdf/unknown-annotation' })
    await assert.rejects(readTool(definitions, 'pdf_bookmark_rename', { documentId: opened.id,
      bookmarkId: '0/0', expectedUpdatedAt: added.updatedAt, title: 'No' }, sessionId), /uuid/i)
    const renamed = await readTool(definitions, 'pdf_bookmark_rename', { documentId: opened.id,
      bookmarkId: added.bookmarkId, expectedUpdatedAt: added.updatedAt, title: 'Updated' },
    sessionId) as { updatedAt: string; title: string }
    assert.equal(renamed.title, 'Updated')
    assert.notEqual(renamed.updatedAt, added.updatedAt)
    await assert.rejects(readTool(definitions, 'pdf_bookmark_rename', { documentId: opened.id,
      bookmarkId: added.bookmarkId, expectedUpdatedAt: added.updatedAt, title: 'Stale' }, sessionId),
    { code: 'pdf/bookmark-stale' })
    await assert.rejects(readTool(definitions, 'pdf_bookmark_remove', { documentId: opened.id,
      bookmarkId: added.bookmarkId, expectedUpdatedAt: renamed.updatedAt }, sessionId),
    { code: 'pdf/approval-unavailable' })
    services.userQuestions = { async ask(request: { questions: Array<{ id: string }> }) {
      return { answers: [{ id: request.questions[0]!.id, selected: ['取消'] }] }
    } }
    await assert.rejects(readTool(definitions, 'pdf_bookmark_remove', { documentId: opened.id,
      bookmarkId: added.bookmarkId, expectedUpdatedAt: renamed.updatedAt }, sessionId),
    { code: 'pdf/approval-rejected' })
    assert.equal((await bookmarks.dispatch(sessionId, { action: 'list', sessionId, id: opened.id },
      agent(sessionId), signal) as unknown[]).length, 1)
    services.userQuestions = { async ask(request: { questions: Array<{ id: string; options: Array<{ label: string }> }> }) {
      return { answers: [{ id: request.questions[0]!.id,
        selected: [request.questions[0]!.options[0]!.label] }] }
    } }
    const removed = await readTool(definitions, 'pdf_bookmark_remove', { documentId: opened.id,
      bookmarkId: added.bookmarkId, expectedUpdatedAt: renamed.updatedAt }, sessionId) as { status: string; total: number }
    assert.deepEqual([removed.status, removed.total], ['removed', 0])
    assert.equal(rows.size, 0)
    assert.equal(state.writes(), 0)

    const draft = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'bookmark-target-note', page: 3, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'Here',
      } }] }, agent(sessionId), signal)
    assert.ok('bytes' in draft)
    await assert.rejects(readTool(definitions, 'pdf_bookmark_add', { documentId: opened.id,
      expectedRevision: opened.revision, title: 'Stale target',
      target: { kind: 'annotation', annotationId: 'bookmark-target-note' } }, sessionId),
    { code: 'pdf/stale-revision' })
    const atNote = await readTool(definitions, 'pdf_bookmark_add', { documentId: opened.id,
      expectedRevision: draft.revision, title: 'At note',
      target: { kind: 'annotation', annotationId: 'bookmark-target-note' } }, sessionId) as { page: number }
    assert.equal(atNote.page, 3)
    const own = await bookmarks.dispatch(sessionId, { action: 'list', sessionId, id: opened.id },
      agent(sessionId), signal) as Array<{ position: { x: number; y: number } }>
    assert.deepEqual([own[0]?.position.x, own[0]?.position.y], [60, 100])
    await assert.rejects(readTool(definitions, 'pdf_bookmark_rename', { documentId: opened.id,
      bookmarkId: added.bookmarkId, expectedUpdatedAt: renamed.updatedAt, title: 'Other session' },
    'pdf-bookmark-foreign'), /session|belong|access/i)
  } finally { await bookmarks.dispose(); await state.workspaces.dispose() }
})

test('model bookmarks reject reply IDs and annotations without usable PDF coordinates', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-bookmark-invalid-target'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const { ctx, definitions } = captureTools()
  let target = { id: 'reply', page: 1, subtype: 'Text', rect: [10, 20, 20, 30],
    replyToId: 'parent', replyType: 'Reply' }
  registerPdfModelBookmarkTools(ctx, { readSnapshot: () => ({ ...opened,
    document: { ...opened.document, annotations: [target] } }) } as never, { dispatch: async () => [] } as never)
  try {
    const input = { documentId: opened.id, expectedRevision: opened.revision, title: 'Target',
      target: { kind: 'annotation', annotationId: 'reply' } }
    await assert.rejects(readTool(definitions, 'pdf_bookmark_add', input, sessionId),
      { code: 'pdf/invalid-bookmark-target' })
    target = { ...target, replyToId: '', replyType: 'Group', rect: [Number.NaN, 20, 20, 30] }
    await assert.rejects(readTool(definitions, 'pdf_bookmark_add', input, sessionId),
      { code: 'pdf/invalid-bookmark-target' })
  } finally { await state.workspaces.dispose() }
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
      { geometry: { status: string }; evidenceSource: { kind: string; snapshotSha256: string };
        lines: Array<{ text: string; box: { x0: number } }> }
    assert.equal(first.geometry.status, 'complete')
    assert.equal(first.evidenceSource.kind, 'ocr-text')
    assert.match(first.evidenceSource.snapshotSha256, /^sha256:/)
    assert.deepEqual(first.lines, [{ id: 'line-1', text: 'Recognized text',
      box: { x0: 1, y0: 2, x1: 30, y1: 40 } }])
    const ocrMeta = definitions.get('pdf_ocr_page')!.output.presentationMeta?.({}, first) as {
      tool: string; snapshot: { text: string; sha256: string }; evidenceSource: { kind: string }
    }
    assert.equal(ocrMeta.tool, 'pdf_ocr_page')
    assert.equal(ocrMeta.snapshot.text, 'Recognized text')
    assert.match(ocrMeta.snapshot.sha256, /^sha256:/)
    assert.equal(ocrMeta.evidenceSource.kind, 'ocr-text')
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
      async readImage(ref: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number }) {
        assert.equal(String(ref.attachmentId), `sha256:${'a'.repeat(64)}`)
        return { ref }
      },
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
    assert.equal((result.evidenceSource as { kind: string }).kind, 'direct-image')
    assert.match(result.refId as string, /^pdfref_/)
    const image = result.image as { width: number; height: number; attachmentId: string }
    assert.ok(image.width <= 512 && image.height <= 512)
    assert.match(image.attachmentId, /^sha256:/)
    const blocks = definitions.get('pdf_render_page')!.output.render({ documentId: opened.id, page: 1 }, result)
    assert.equal(blocks[1]?.type, 'image')
    assert.equal(blocks[1]?.attachment?.attachmentId, image.attachmentId)
    assert.ok(!JSON.stringify(result).includes('iVBOR'), 'canonical output must not embed Base64 image bytes')
    const renderMeta = definitions.get('pdf_render_page')!.output.presentationMeta?.({}, result) as {
      status: string; refId: string; attachment: { attachmentId: string }; evidenceSource: { kind: string }
    }
    assert.equal(renderMeta.status, 'direct-image')
    assert.equal(renderMeta.refId, result.refId)
    assert.equal(renderMeta.attachment.attachmentId, image.attachmentId)
    assert.equal(renderMeta.evidenceSource.kind, 'direct-image')
    assert.ok(!JSON.stringify(renderMeta).includes('iVBOR'), 'replay metadata must reference rather than embed PNG bytes')
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
    assert.match(recognized.refId as string, /^pdfref_/)
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

test('pdf_image_context reauthorizes stored image/OCR refs and fails closed across sessions, source changes, attachment loss, and cancellation', async () => {
  const state = memoryWorkspace(await nativeFixture())
  let sourceOnDisk = state.current()
  const alice = 'pdf-image-ref-alice', bob = 'pdf-image-ref-bob'
  const open = async (sessionId: string) => {
    const result = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
      address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
    assert.ok('bytes' in result)
    return result.id
  }
  const aliceDocument = await open(alice)
  const bobDocument = await open(bob)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64')
  const attachmentId = `sha256:${'b'.repeat(64)}`
  let visual = true, attachmentPresent = true, sourceChanged = false, imageReads = 0
  let cancelDuringRead: AbortController | undefined
  const services: Record<string, unknown> = {
    llm: { async resolveModelInfo() { return { inputModalities: visual ? ['text', 'image'] : ['text'] } } },
    attachments: {
      imageLimits: { mediaTypes: ['image/png'] },
      async saveImage() { return { attachmentId, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } },
      async readImage(ref: { attachmentId: string }) {
        imageReads++
        assert.equal(String(ref.attachmentId), attachmentId)
        if (!attachmentPresent) throw new Error('Deleted attachment')
        if (cancelDuringRead) {
          cancelDuringRead.abort()
          cancelDuringRead = undefined
        }
        return { ref: { attachmentId, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } }
      },
    },
    ocr: {
      selectedDescriptor() { return { languages: ['auto'] } },
      async availability() { return { status: 'available' } },
      async recognize() { return { text: 'Labels found by OCR', status: 'complete',
        source: { backendId: 'test-ocr', backendVersion: '1' },
        blocks: [], lines: [], words: [], warnings: [] } },
    },
    imageUnderstanding: {
      async availability() { return { status: 'available', kind: 'derived-text' } },
      async prepare() { return { kind: 'derived-text', text: 'A scanned figure with two axes.',
        provenance: { backendId: 'test-vision', mode: 'image-description', model: 'small-vision' } } },
    },
  }
  const fencedWorkspaces = { ...state.workspaces,
    readSnapshot(sessionId: string, documentId: string) {
      const current = state.workspaces.readSnapshot(sessionId, documentId)
      return sourceChanged ? { ...current, bytes: Buffer.from('%PDF-changed-source') } : current
    },
  }
  const { ctx, definitions } = captureTools(services)
  const sourceFiles = { async read(_agent: unknown, path: string, readSignal?: AbortSignal) {
    readSignal?.throwIfAborted()
    return { path, bytes: sourceOnDisk, version: evidenceSha256(sourceOnDisk),
      fsVersion: 'fixture-source', size: sourceOnDisk.byteLength }
  } }
  const dispose = registerPdfAgentTools(ctx, fencedWorkspaces, {
    async renderPage(sessionId: string, documentId: string) {
      return { snapshot: fencedWorkspaces.readSnapshot(sessionId, documentId), png, width: 1, height: 1 }
    },
    async releaseDocument() {},
  } as never, { current: () => [] }, undefined, undefined, sourceFiles)
  const run = (name: string, args: unknown, sessionId: string, callSignal: AbortSignal = signal) => {
    const tool = definitions.get(name)
    assert.ok(tool)
    return tool.execute(args, { signal: callSignal, agent: {
      session: { id: sessionId, requestHeader: () => ({ config: { provider: 'test', model: 'active-model' } }) },
      options: { provider: 'test', model: 'active-model' },
    } }) as Promise<Record<string, unknown>>
  }
  const tool = definitions.get('pdf_image_context')
  assert.ok(tool, 'the reference consumer must be registered')
  try {
    const direct = await run('pdf_render_page', { documentId: aliceDocument, page: 1 }, alice)
    assert.match(String(direct.refId), /^pdfref_/)
    const replay = await run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId }, alice)
    assert.equal(replay.status, 'direct-image')
    assert.equal(replay.source, 'direct-image')
    assert.equal(replay.refId, direct.refId)
    assert.equal((replay.image as { attachmentId: string }).attachmentId, attachmentId)
    assert.deepEqual(tool.output.render({}, replay).map(block => block.type), ['text', 'image'])
    const meta = tool.output.presentationMeta?.({}, replay) as { tool: string; status: string;
      refId: string; attachment: { attachmentId: string }; sourcePathDigest: string }
    assert.equal(meta.tool, 'pdf_image_context')
    assert.equal(meta.status, 'direct-image')
    assert.equal(meta.refId, direct.refId)
    assert.equal(meta.attachment.attachmentId, attachmentId)
    assert.match(meta.sourcePathDigest, /^sha256:/)
    assert.ok(!JSON.stringify(meta).includes(png.toString('base64')), 'replay metadata must never embed image bytes')
    assert.ok(imageReads >= 2, 'mint and replay must independently attest the attachment')

    sourceOnDisk = Buffer.from('%PDF-overwritten-without-reopening')
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId }, alice),
      { code: 'pdf/stale-reader' })
    assert.equal(fencedWorkspaces.readSnapshot(alice, aliceDocument).revision,
      state.workspaces.readSnapshot(alice, aliceDocument).revision)
    sourceOnDisk = state.current()

    visual = false
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId }, alice),
      { code: 'pdf/image-input-unsupported' })
    const derived = await run('pdf_render_page', { documentId: aliceDocument, page: 1,
      mode: 'configured-backend' }, alice)
    const textReplay = await run('pdf_image_context', { documentId: aliceDocument, refId: derived.refId }, alice)
    assert.equal(textReplay.status, 'derived-text')
    assert.equal(textReplay.source, 'auxiliary-vision')
    assert.equal(textReplay.text, 'A scanned figure with two axes.')
    assert.equal(textReplay.backendId, 'test-vision')
    assert.deepEqual(tool.output.render({}, textReplay).map(block => block.type), ['text'])
    const textMeta = tool.output.presentationMeta?.({}, textReplay) as {
      snapshot: { text: string }; backend: { model: string } }
    assert.equal(textMeta.snapshot.text, textReplay.text)
    assert.equal(textMeta.backend.model, 'small-vision')
    const ocr = await run('pdf_ocr_page', { documentId: aliceDocument, page: 1 }, alice)
    const ocrReplay = await run('pdf_image_context', { documentId: aliceDocument, refId: ocr.refId }, alice)
    assert.equal(ocrReplay.source, 'ocr-text')
    assert.equal(ocrReplay.text, 'Labels found by OCR')
    assert.equal(ocrReplay.backendId, 'test-ocr')
    assert.deepEqual(tool.output.render({}, ocrReplay).map(block => block.type), ['text'])

    await assert.rejects(run('pdf_image_context', { documentId: bobDocument, refId: direct.refId }, bob),
      { code: 'pdf/reference-unavailable' })
    await assert.rejects(run('pdf_image_context', { documentId: bobDocument, refId: derived.refId }, bob),
      { code: 'pdf/reference-unavailable' })
    sourceChanged = true
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId }, alice),
      { code: 'pdf/stale-reader' })
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: derived.refId }, alice),
      { code: 'pdf/stale-reader' })
    sourceChanged = false
    attachmentPresent = false
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId }, alice),
      { code: 'pdf/attachment-unavailable' })
    attachmentPresent = true
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId },
      alice, cancelled.signal), /abort/i)
    const cancelledInFlight = new AbortController()
    cancelDuringRead = cancelledInFlight
    await assert.rejects(run('pdf_image_context', { documentId: aliceDocument, refId: direct.refId },
      alice, cancelledInFlight.signal), /abort/i)
    await assert.rejects(run('pdf_image_context', { documentId: bobDocument, refId: direct.refId }, alice),
      /session|belong|access/i)
  } finally { await dispose(); await state.workspaces.dispose() }
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
    assert.equal((derived.evidenceSource as { kind: string }).kind, 'auxiliary-vision')
    assert.equal(derived.text, 'A diagram with three nodes.')
    assert.deepEqual(derived.source, { backendId: 'test-backend', mode: 'image-description', model: 'cheap-vision' })
    assert.equal(derived.limitations, 'Generated visual description may omit fine details.')
    assert.equal(rendered, 1)
    assert.equal(prepared, 1)
    assert.equal(saved, 0)
    assert.deepEqual(tool.output.render(args, derived).map(block => block.type), ['text'])
    const derivedMeta = tool.output.presentationMeta?.(args, derived) as {
      status: string; source: { mode: string; model?: string }; snapshot: { text: string; sha256: string }
    }
    assert.equal(derivedMeta.status, 'derived-text')
    assert.equal(derivedMeta.source.mode, 'image-description')
    assert.equal(derivedMeta.source.model, 'cheap-vision')
    assert.equal(derivedMeta.snapshot.text, 'A diagram with three nodes.')
    assert.match(derivedMeta.snapshot.sha256, /^sha256:/)
    description = 'detail '.repeat(1_500)
    const longDescription = await tool.execute({ ...args, mode: 'configured-backend' }, exec) as Record<string, unknown>
    assert.equal(longDescription.text, description.slice(0, 8_000))
    assert.equal(longDescription.totalChars, description.length)
    assert.equal(longDescription.truncated, true)
    assert.match(String(longDescription.limitations), /truncated/i)
    const longMeta = tool.output.presentationMeta?.(args, longDescription) as {
      totalChars: number; snapshot: { text: string; truncated: boolean }
    }
    assert.equal(longMeta.totalChars, description.length)
    assert.equal(longMeta.snapshot.text.length, 8000)
    assert.equal(longMeta.snapshot.truncated, true)
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
    const replay = definitions.get('pdf_read_page')!.output.presentationMeta?.({}, page) as {
      snapshot: { text: string }; sourceDigest: string; sourceVersion: string
    }
    assert.equal(replay.snapshot.text, page.text)
    assert.match(replay.sourceDigest, /^sha256:/)
    assert.equal(replay.sourceVersion, opened.sourceVersion)

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

test('evidence tools register through the same session-fenced Host adapter as legacy tools', async () => {
  const state = memoryWorkspace(await nativeFixture())
  const sessionId = 'pdf-evidence-agent'
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent(sessionId), signal)
  assert.ok('bytes' in opened)
  const pdfService = { async readPageText(callerSession: string, id: string, page: number) {
    const snapshot = state.workspaces.readSnapshot(callerSession, id)
    if (page < 1 || page > snapshot.document.pageCount) throw new Error('Page outside document')
    return { snapshot, content: { items: [{ str: page === 1 ? 'Evidence appears on page one' : '',
      transform: [1, 0, 0, 1, 0, 0], width: 100, height: 10,
      dir: 'ltr', fontName: 'Helvetica', hasEOL: false }], styles: {}, lang: null } }
  }, async releaseDocument() {} }
  const { ctx, definitions } = captureTools()
  const dispose = registerPdfAgentTools(ctx, state.workspaces, pdfService as never, { current: () => [] })
  try {
    for (const name of ['pdf_status', 'pdf_locate', 'pdf_context', 'pdf_find_related']) assert.ok(definitions.has(name))
    const status = await readTool(definitions, 'pdf_status', { documentId: opened.id }, sessionId) as Record<string, unknown>
    assert.equal(status.status, 'ok')
    assert.equal(status.visibleInReader, false)
    assert.equal(status.revision, opened.revision)
    assert.equal(status.capabilities && (status.capabilities as Record<string, unknown>).writeAnnotations, true)
    const located = await readTool(definitions, 'pdf_locate', {
      documentId: opened.id, quote: 'Evidence', page: 1,
    }, sessionId) as { status: string; matches: Array<{ evidence: { refId: string; page: number } }> }
    assert.equal(located.status, 'ok')
    assert.equal(located.matches[0]?.evidence.page, 1)
    const related = await readTool(definitions, 'pdf_find_related', {
      documentId: opened.id, query: 'Does this document present evidence?', terms: ['Evidence'], maxPages: 1,
    }, sessionId) as { candidates: Array<{ page: number; quote: string; evidence: { refId: string } }>; coverage: { nextCursor: string | null } }
    assert.equal(related.candidates[0]?.page, 1)
    assert.match(related.candidates[0]?.quote ?? '', /Evidence/)
    assert.ok(related.candidates[0]?.evidence.refId)
    assert.ok(related.coverage.nextCursor)
    const locateReplay = definitions.get('pdf_locate')!.output.presentationMeta?.({}, located) as {
      matches: Array<{ snapshot: { text: string } }>
    }
    assert.equal(locateReplay.matches[0]?.snapshot.text, 'Evidence')
    const context = await readTool(definitions, 'pdf_context', { documentId: opened.id,
      focus: { kind: 'reference', refId: located.matches[0]!.evidence.refId }, maxPages: 1,
    }, sessionId) as { chunks: Array<{ evidence: { snapshot: { text: string } } }> }
    assert.match(context.chunks[0]?.evidence.snapshot.text ?? '', /Evidence/)
    const contextReplay = definitions.get('pdf_context')!.output.presentationMeta?.({}, context) as {
      chunks: Array<{ snapshot: { text: string } }>
    }
    assert.match(contextReplay.chunks[0]?.snapshot.text ?? '', /Evidence/)
    await assert.rejects(readTool(definitions, 'pdf_status', { documentId: opened.id }, 'other'), /session|belong|access/i)
    await assert.rejects(readTool(definitions, 'pdf_locate', { documentId: opened.id, quote: 'Evidence' }), /session/i)
  } finally { dispose(); await state.workspaces.dispose() }
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
      documentId: opened.id, tabId: 'reader-a', path: opened.path, page: 3, pageCount: 4,
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
