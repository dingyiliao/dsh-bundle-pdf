import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryEvidenceReferenceStore, evidenceSha256 } from '../../../src/modules/evidence/index.ts'
import { prepareTextSelectionEvidence, type SelectionFragment } from '../../../src/modules/evidence/selection.ts'
import type { HostWorkspaceSnapshot } from '../../../src/modules/working-copy/index.ts'
import type { NativeTextContent } from '../../../src/shared/native.ts'

const owner = 'session-a', documentId = 'doc-a'
const signal = new AbortController().signal
const pageInfo = (page: number) => ({ page, cropBox: [0, 0, 200, 200] as [number, number, number, number],
  rotation: 0, userUnit: 1 })

function textContent(text: string): NativeTextContent {
  return { items: [{ str: text, transform: [1, 0, 0, 1, 10, 40], width: text.length * 10, height: 10,
    dir: 'ltr', fontName: 'test', hasEOL: false,
    glyphs: Array.from(text).map((_, index) => [10 + 10 * index, 40, 10]) }], styles: {}, lang: null }
}

function pageSelection(page: number, length: number): SelectionFragment {
  const right = 10 + length * 10
  return { page, rect: [10, 38, right, 50], quadPoints: [10, 50, right, 50, 10, 38, right, 38] }
}

function fixture(texts: string[]) {
  let revision = 3, contentVersion = 'content-a', path = '/paper.pdf'
  let bytes = Buffer.from('%PDF-original')
  let sourceBytes = bytes
  let onRead: (() => void) | undefined
  const snapshot = (): HostWorkspaceSnapshot => ({ id: documentId, path, bytes,
    sourceVersion: 'source-a', contentVersion, revision, dirty: false,
    canUndo: false, canRedo: false, conflict: false,
    document: { pageCount: texts.length, pages: texts.map((_, index) => pageInfo(index + 1)),
      annotations: [], signed: false, encrypted: false, readOnly: false },
  } as HostWorkspaceSnapshot)
  const workspaces = { readSnapshot(session: string, id: string) {
    if (session !== owner || id !== documentId) {
      throw Object.assign(new Error('Foreign working copy'), { code: 'pdf/session-mismatch' })
    }
    return snapshot()
  } }
  const reader = { async readPageText(session: string, id: string, page: number) {
    const captured = workspaces.readSnapshot(session, id)
    const content = textContent(texts[page - 1]!)
    onRead?.()
    return { snapshot: captured, content }
  } }
  const readSource = async (_session: string, observed: HostWorkspaceSnapshot, readSignal: AbortSignal) => {
    readSignal.throwIfAborted()
    return { path: observed.path, digest: evidenceSha256(sourceBytes) }
  }
  const references = createMemoryEvidenceReferenceStore()
  const input = { sessionId: owner, documentId, expectedRevision: revision,
    expectedContentVersion: contentVersion, quote: texts.join('\n'),
    fragments: texts.map((text, index) => pageSelection(index + 1, text.length)) }
  return { workspaces, reader, references, input, readSource,
    revise() { revision++ }, replaceBytes() { bytes = Buffer.from('%PDF-replaced') },
    changeContentVersion() { contentVersion = 'content-b' }, move() { path = '/other.pdf' },
    overwriteSource() { sourceBytes = Buffer.from('%PDF-external-overwrite') },
    afterRead(callback: () => void) { onRead = callback },
  }
}

test('Host re-extracts selected glyphs, mints per-page refs, and canonicalizes whitespace', async () => {
  const state = fixture(['Hello', 'World'])
  const result = await prepareTextSelectionEvidence(state.workspaces, state.reader, state.references,
    { ...state.input, quote: 'Hello  World' }, signal, state.readSource)
  assert.equal(result.text, 'Hello\nWorld')
  assert.deepEqual(result.excerpts.map(item => item.page), [1, 2])
  assert.deepEqual(result.excerpts.map(item => item.text), ['Hello', 'World'])
  assert.ok(result.excerpts.every(item => /^pdfref_[0-9a-f-]{36}$/.test(item.refId)))
  for (const excerpt of result.excerpts) {
    const saved = state.references.get(excerpt.refId)
    assert.equal(saved?.evidence.source, 'pdf-text')
    assert.equal(saved?.sessionId, owner)
    assert.equal(saved?.evidence.sourceDigest, evidenceSha256(Buffer.from('%PDF-original')))
  }
})

test('Host rejects forged quote, unrelated geometry, missing glyph positions, and unordered pages', async () => {
  const state = fixture(['Hello', 'World'])
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, state.reader, state.references,
    { ...state.input, quote: 'Forged\nWorld' }, signal, state.readSource), { code: 'pdf/selection-mismatch' })
  assert.equal(state.references.get('forged'), undefined)
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, state.reader, state.references,
    { ...state.input, fragments: [
      { page: 1, rect: [130, 90, 170, 110], quadPoints: [130, 110, 170, 110, 130, 90, 170, 90] },
      state.input.fragments[1]!,
    ] }, signal, state.readSource), { code: 'pdf/selection-unverifiable' })
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, state.reader, state.references,
    { ...state.input, fragments: [...state.input.fragments].reverse() }, signal, state.readSource), { code: 'pdf/invalid-selection' })
  const noGlyphs = { async readPageText() { const result = await state.reader.readPageText(owner, documentId, 1)
    return { ...result, content: { ...result.content, items: [{ ...result.content.items[0]!, glyphs: undefined }] } } } }
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, noGlyphs, state.references,
    { ...state.input, quote: 'Hello', fragments: [state.input.fragments[0]!] }, signal, state.readSource),
  { code: 'pdf/selection-unverifiable' })
})

test('Host rejects malformed quads, degenerate glyph axes, bad glyph origins, and discontinuous selections', async () => {
  const state = fixture(['Hello'])
  const base = await state.reader.readPageText(owner, documentId, 1)
  const read = (content: NativeTextContent) => ({ async readPageText() { return { ...base, content } } })
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, read(base.content), state.references,
    { ...state.input, fragments: [{ ...state.input.fragments[0]!,
      quadPoints: [10, 53, 60, 53, 10, 41, 60, 41] }] }, signal, state.readSource),
  { code: 'pdf/invalid-selection' })

  const item = base.content.items[0]!
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, read({ ...base.content,
    items: [{ ...item, transform: [0, 0, 0, 0, 10, 40] }] }), state.references,
    { ...state.input, quote: 'Hello', fragments: [state.input.fragments[0]!] }, signal, state.readSource),
  { code: 'pdf/selection-unverifiable' })
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, read({ ...base.content,
    items: [{ ...item, glyphs: [[10, 40, 0], ...item.glyphs!.slice(1)] }] }), state.references,
    { ...state.input, quote: 'Hello', fragments: [state.input.fragments[0]!] }, signal, state.readSource),
  { code: 'pdf/selection-unverifiable' })

  const discontinuous: NativeTextContent = { ...base.content, items: [{ ...item, str: 'HXL',
    width: 60, glyphs: [[10, 40, 10], [50, 40, 10], [20, 40, 10]] }] }
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, read(discontinuous), state.references,
    { ...state.input, quote: 'HL', fragments: [{ page: 1, rect: [9, 38, 31, 50],
      quadPoints: [9, 50, 31, 50, 9, 38, 31, 38] }] }, signal, state.readSource),
  { code: 'pdf/selection-unverifiable' })
})

test('Host fails closed on source or working-copy mutation before and after native read', async () => {
  for (const mutation of ['revision', 'bytes', 'path', 'content'] as const) {
    const state = fixture(['Hello'])
    state.afterRead(() => {
      if (mutation === 'revision') state.revise()
      if (mutation === 'bytes') state.replaceBytes()
      if (mutation === 'path') state.move()
      if (mutation === 'content') state.changeContentVersion()
    })
    await assert.rejects(prepareTextSelectionEvidence(state.workspaces, state.reader, state.references,
      state.input, signal, state.readSource), { code: 'pdf/stale-reader' })
  }
  const stale = fixture(['Hello'])
  stale.revise()
  await assert.rejects(prepareTextSelectionEvidence(stale.workspaces, stale.reader, stale.references,
    stale.input, signal, stale.readSource), { code: 'pdf/stale-reader' })
})

test('external source overwrite is rejected even when the in-memory working copy did not change', async () => {
  const before = fixture(['Hello'])
  before.overwriteSource()
  await assert.rejects(prepareTextSelectionEvidence(before.workspaces, before.reader, before.references,
    before.input, signal, before.readSource), { code: 'pdf/stale-reader' })
  const during = fixture(['Hello'])
  let storedKey: string | undefined
  const references = { ...during.references,
    async put(key: string, value: Parameters<typeof during.references.put>[1]) {
      storedKey = key
      await during.references.put(key, value)
      during.overwriteSource()
    },
  }
  await assert.rejects(prepareTextSelectionEvidence(during.workspaces, during.reader, references,
    during.input, signal, during.readSource), { code: 'pdf/stale-reader' })
  assert.equal(storedKey && during.references.get(storedKey), undefined)

  const changedWorkingCopy = fixture(['Hello'])
  let changedKey: string | undefined
  const changingStore = { ...changedWorkingCopy.references,
    async put(key: string, value: Parameters<typeof changedWorkingCopy.references.put>[1]) {
      changedKey = key
      await changedWorkingCopy.references.put(key, value)
      changedWorkingCopy.revise()
    },
  }
  await assert.rejects(prepareTextSelectionEvidence(changedWorkingCopy.workspaces, changedWorkingCopy.reader,
    changingStore, changedWorkingCopy.input, signal, changedWorkingCopy.readSource), { code: 'pdf/stale-reader' })
  assert.equal(changedKey && changedWorkingCopy.references.get(changedKey), undefined)
})

test('cancellation and a failed second write leave no half-complete selection references', async () => {
  const state = fixture(['Hello', 'World'])
  const controller = new AbortController()
  let abortedKey: string | undefined
  const wrapped = { ...state.references, async put(key: string, value: Parameters<typeof state.references.put>[1]) {
    await state.references.put(key, value)
    abortedKey = key
    controller.abort()
  } }
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, state.reader, wrapped,
    state.input, controller.signal, state.readSource), { name: 'AbortError' })
  assert.equal(abortedKey && state.references.get(abortedKey), undefined)
  let count = 0, firstKey: string | undefined
  const failedStore = { ...state.references, async put(key: string, value: Parameters<typeof state.references.put>[1]) {
    count++
    if (count === 2) throw new Error('Storage unavailable')
    firstKey = key
    await state.references.put(key, value)
  } }
  await assert.rejects(prepareTextSelectionEvidence(state.workspaces, state.reader, failedStore,
    state.input, signal, state.readSource), /Storage unavailable/)
  assert.equal(firstKey && state.references.get(firstKey), undefined)
})
