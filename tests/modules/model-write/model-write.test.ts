import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelWriteService } from '../../../src/modules/model-write/index.ts'
import { buildSaveReview } from '../../../src/modules/model-write/save-review.ts'
import { memoryWorkspace, nativeFixture } from '../../native-fixture.ts'

const signal = new AbortController().signal
const sessionId = 'pdf-model-write'
const agent = { session: { id: sessionId, header: {} } }
const target = { kind: 'pdf-region' as const, page: 1, rectPdf: [60, 80, 120, 100] as [number, number, number, number] }

async function fixture(now?: () => number) {
  const state = memoryWorkspace(await nativeFixture())
  const opened = await state.workspaces.execute(sessionId, { action: 'open', sessionId,
    address: `dsh-resource://file/session/${sessionId}//fixtures/native.pdf` }, agent, signal)
  assert.ok('bytes' in opened)
  const writes = createModelWriteService(state.workspaces, now)
  return { state, opened, writes }
}

function proposal(id: string, revision: number) {
  return { documentId: id, expectedRevision: revision,
    subtype: 'Highlight' as const, target, color: [1, 1, 0] as [number, number, number], comment: 'AI suggestion' }
}

test('model write preview is pure; reviewed commit creates one undoable draft; save separately changes bytes', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const source = state.current().slice()
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    assert.equal(proposed.status, 'preview')
    assert.equal(proposed.preview.beforeAnnotations! + 1, proposed.preview.afterAnnotations)
    assert.equal(state.writes(), 0)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.deepEqual(state.current(), source)
    let inspected = false
    const committed = await writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal, async detail => {
      inspected = detail.kind === 'annotation' && detail.page === 1 && detail.subtype === 'Highlight'
        && detail.comment === 'AI suggestion' && detail.path === '/fixtures/native.pdf'
        && detail.beforeAnnotations! + 1 === detail.afterAnnotations
      assert.equal(state.writes(), 0)
      return true
    })
    assert.equal(inspected, true)
    assert.equal(committed.dirty, true)
    assert.equal(committed.approval, 'user-questions-selected')
    assert.equal(committed.canUndo, true)
    assert.equal(state.writes(), 0, 'commit changes only the persisted draft')
    assert.deepEqual(state.current(), source)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).document.annotations.length,
      opened.document.annotations.length + 1)
    assert.deepEqual(await writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal,
      async () => { throw Error('replay must not ask or duplicate') }), committed)
    const saved = await writes.save(sessionId, { documentId: opened.id, expectedRevision: committed.revision },
      agent, signal, async detail => {
        assert.equal(detail.kind, 'save')
        assert.equal(detail.path, '/fixtures/native.pdf')
        assert.equal(detail.revision, committed.revision)
        assert.equal(detail.dirty, true)
        assert.equal(detail.saveChangeCount, 1)
        assert.match(detail.saveDiffText!, /AI suggestion/)
        assert.equal(state.writes(), 0)
        return true
      })
    assert.equal(saved.status, 'saved')
    assert.equal(saved.approval, 'user-questions-selected')
    assert.equal(saved.dirty, false)
    assert.equal(state.writes(), 1)
    assert.notDeepEqual(state.current(), source)
    assert.equal((await writes.save(sessionId, { documentId: opened.id, expectedRevision: saved.revision },
      agent, signal, async () => { throw Error('clean save must not ask') })).status, 'no_changes')
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('declined annotation and save never mutate draft or file', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal, async () => false),
      { code: 'pdf/approval-rejected' })
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal, async () => true),
      { code: 'pdf/proposal-rejected' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
    const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'human-note', page: 1, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'manual',
      } }] }, agent, signal)
    assert.ok('bytes' in changed)
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: changed.revision },
      agent, signal, async () => false), { code: 'pdf/approval-rejected' })
    assert.equal(state.writes(), 0)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, true)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('proposal expires, is session-bound, rejects approximate reference and invalid regions', async () => {
  let time = 1000
  const { state, opened, writes } = await fixture(() => time)
  try {
    await assert.rejects(writes.preview(sessionId, {
      ...proposal(opened.id, opened.revision), target: { kind: 'reference', refId: 'pdfref_123' },
    }, agent, signal), { code: 'pdf/approximate-target' })
    await assert.rejects(writes.preview(sessionId, {
      ...proposal(opened.id, opened.revision), target: { ...target, rectPdf: [5, 80, 120, 100] },
    }, agent, signal), { code: 'pdf/invalid-region' })
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit('different-session', { proposalId: proposed.proposalId }, agent, signal,
      async () => true), { code: 'pdf/proposal-unavailable' })
    time += 5 * 60_000
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal,
      async () => true), { code: 'pdf/proposal-expired' })
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('a proposal that expires while the human reviews cannot be committed', async () => {
  let time = 1000
  const { state, opened, writes } = await fixture(() => time)
  try {
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal, async () => {
      time += 5 * 60_000
      return true
    }), { code: 'pdf/proposal-expired' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('a change while human reviews invalidates annotation and save approval before mutation', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal, async () => {
      await state.workspaces.execute(sessionId, { action: 'change', sessionId, id: opened.id,
        revision: opened.revision, operations: [{ type: 'add', annotation: {
          id: 'concurrent-note', page: 1, subtype: 'Text', rect: [60, 80, 90, 100],
        } }] }, agent, signal)
      return true
    }), { code: 'pdf/stale-revision' })
    const dirty = state.workspaces.readSnapshot(sessionId, opened.id)
    assert.equal(dirty.document.annotations.length, opened.document.annotations.length + 1)
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: dirty.revision },
      agent, signal, async () => {
        await state.workspaces.execute(sessionId, { action: 'undo', sessionId, id: opened.id,
          revision: dirty.revision }, agent, signal)
        return true
      }), { code: 'pdf/stale-revision' })
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('abort and review failure fail closed without writes', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    const controller = new AbortController()
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, controller.signal,
      async () => { controller.abort(); return true }), /abort/i)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('external source change during review is rejected before draft mutation', async () => {
  const { state, opened } = await fixture()
  let externalChange = false
  const writes = createModelWriteService({
    readSnapshot: state.workspaces.readSnapshot,
    async execute(owner, input, caller, abort) {
      if (externalChange && input.action === 'inspectTarget') return { version: `sha256:${'0'.repeat(64)}` }
      return state.workspaces.execute(owner, input, caller, abort)
    },
  })
  try {
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal, async () => {
      externalChange = true
      return true
    }), { code: 'pdf/source-conflict' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('preview refuses a working-copy change between source check and projected review', async () => {
  const { state, opened } = await fixture()
  let reads = 0
  const writes = createModelWriteService({
    readSnapshot(owner, id) {
      const snapshot = state.workspaces.readSnapshot(owner, id)
      return ++reads === 2 ? { ...snapshot, contentVersion: 'concurrent-content' } : snapshot
    },
    execute: state.workspaces.execute,
  })
  try {
    await assert.rejects(writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal),
      { code: 'pdf/stale-revision' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('commit rejects a proposal when its source identity changes without a revision bump', async () => {
  const { state, opened } = await fixture()
  let moved = false
  const writes = createModelWriteService({
    readSnapshot(owner, id) {
      const snapshot = state.workspaces.readSnapshot(owner, id)
      return moved ? { ...snapshot, path: '/other-file.pdf' } : snapshot
    },
    execute: state.workspaces.execute,
  })
  try {
    const proposed = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    moved = true
    let asked = false
    await assert.rejects(writes.commit(sessionId, { proposalId: proposed.proposalId }, agent, signal,
      async () => { asked = true; return true }), { code: 'pdf/stale-proposal' })
    assert.equal(asked, false, 'a stale proposal never reaches the approval UI')
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('save refuses annotation changes that occur during review without advancing revision', async () => {
  const { state, opened } = await fixture()
  const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
    id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
      id: 'manual-note', page: 1, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'reviewed text',
    } }] }, agent, signal)
  assert.ok('bytes' in changed)
  let altered = false
  const writes = createModelWriteService({
    readSnapshot(owner, id) {
      const snapshot = state.workspaces.readSnapshot(owner, id)
      if (!altered) return snapshot
      return { ...snapshot, document: { ...snapshot.document,
        annotations: snapshot.document.annotations.map(annotation => annotation.id === 'manual-note'
          ? { ...annotation, contents: 'unreviewed text' } : annotation),
      } }
    },
    execute: state.workspaces.execute,
  })
  try {
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: changed.revision },
      agent, signal, async detail => {
        assert.match(detail.saveDiffText!, /reviewed text/)
        altered = true
        return true
      }), { code: 'pdf/stale-revision' })
    assert.equal(state.writes(), 0)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, true)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('disposed model-write service cannot request save approval or publish a reviewed save', async () => {
  const { state, opened } = await fixture()
  const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
    id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
      id: 'unsaved-note', page: 1, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'keep in draft',
    } }] }, agent, signal)
  assert.ok('bytes' in changed)
  try {
    const alreadyDisposed = createModelWriteService(state.workspaces)
    alreadyDisposed.dispose()
    let asked = false
    await assert.rejects(alreadyDisposed.save(sessionId, { documentId: opened.id,
      expectedRevision: changed.revision }, agent, signal,
    async () => { asked = true; return true }), { code: 'pdf/write-unavailable' })
    assert.equal(asked, false)

    const disposedDuringReview = createModelWriteService(state.workspaces)
    await assert.rejects(disposedDuringReview.save(sessionId, { documentId: opened.id,
      expectedRevision: changed.revision }, agent, signal, async () => {
      disposedDuringReview.dispose()
      return true
    }), { code: 'pdf/write-unavailable' })
    assert.equal(state.writes(), 0)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, true)
  } finally { await state.workspaces.dispose() }
})

test('the shared working-copy change queue enforces optional source CAS for model edits', async () => {
  const { state, opened, writes } = await fixture()
  try {
    await assert.rejects(state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, expectedSourceHash: `sha256:${'0'.repeat(64)}`,
      operations: [{ type: 'add', annotation: { id: 'must-not-exist', page: 1, subtype: 'Text',
        rect: [60, 80, 90, 100], contents: 'blocked' } }],
    }, agent, signal), { code: 'pdf/source-conflict' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('a model-authored text note requires visible, non-empty comment content', async () => {
  const { state, opened, writes } = await fixture()
  try {
    await assert.rejects(writes.preview(sessionId, {
      ...proposal(opened.id, opened.revision), subtype: 'Text', comment: '   ',
    }, agent, signal), { code: 'pdf/invalid-comment' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('save review covers final manual and AI changes, including add, update and delete', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const baseline = state.workspaces.readSnapshot(sessionId, opened.id)
    const old = { id: 'existing-comment', page: 1, subtype: 'Text', rect: [60, 80, 90, 100],
      contents: 'before', color: [1, 0, 0], flags: 0, supported: true, editable: true }
    const removed = { ...old, id: 'removed-comment', contents: 'remove me' }
    const synthetic = { ...baseline, baselineAnnotations: [old, removed], document: {
      ...baseline.document, annotations: [{ ...old, contents: 'after', color: [0, 1, 0] },
        { ...old, id: 'manual-comment', contents: 'manual draft' },
        { ...old, id: 'ai-comment', subtype: 'Highlight', contents: 'AI draft' }],
    } } as typeof baseline
    const review = buildSaveReview(synthetic)
    assert.equal(review.count, 4)
    assert.match(review.text, /评论："before" → "after"/)
    assert.match(review.text, /颜色：\[1,0,0\] → \[0,1,0\]/)
    assert.match(review.text, /删除批注 ID："removed-comment"/)
    assert.match(review.text, /新增批注 ID："manual-comment"/)
    assert.match(review.text, /新增批注 ID："ai-comment"/)

    const manual = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'manual-real', page: 1, subtype: 'Text', rect: [60, 80, 90, 100], contents: 'manual draft',
      } }] }, agent, signal)
    assert.ok('bytes' in manual)
    const preview = await writes.preview(sessionId, proposal(opened.id, manual.revision), agent, signal)
    const committed = await writes.commit(sessionId, { proposalId: preview.proposalId }, agent, signal,
      async () => true)
    const saved = await writes.save(sessionId, { documentId: opened.id, expectedRevision: committed.revision },
      agent, signal, async detail => {
        assert.equal(detail.saveChangeCount, 2)
        assert.match(detail.saveDiffText!, /manual draft/)
        assert.match(detail.saveDiffText!, /AI suggestion/)
        assert.match(detail.saveDiffText!, /页码：∅ → 1/)
        assert.equal(state.writes(), 0)
        return true
      })
    assert.equal(saved.status, 'saved')
    assert.equal(state.writes(), 1)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model save refuses an over-limit review before asking for approval or writing', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: Array.from({ length: 9 }, (_, index) => ({
        type: 'add', annotation: { id: `manual-${index}`, page: 1, subtype: 'Text',
          rect: [60 + index, 80, 90 + index, 100], contents: `manual ${index}` },
      })) }, agent, signal)
    assert.ok('bytes' in changed)
    let asked = false
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: changed.revision },
      agent, signal, async () => { asked = true; return true }), { code: 'pdf/review-too-large' })
    assert.equal(asked, false)
    assert.equal(state.writes(), 0)
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).dirty, true)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('model save also refuses an oversized comment instead of silently truncating review text', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const changed = await state.workspaces.execute(sessionId, { action: 'change', sessionId,
      id: opened.id, revision: opened.revision, operations: [{ type: 'add', annotation: {
        id: 'long-manual-note', page: 1, subtype: 'Text', rect: [60, 80, 90, 100],
        contents: 'x'.repeat(6500),
      } }] }, agent, signal)
    assert.ok('bytes' in changed)
    let asked = false
    await assert.rejects(writes.save(sessionId, { documentId: opened.id, expectedRevision: changed.revision },
      agent, signal, async () => { asked = true; return true }), { code: 'pdf/review-too-large' })
    assert.equal(asked, false)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})

test('proposal being reviewed is not evicted and a full busy ledger refuses new previews', async () => {
  const { state, opened, writes } = await fixture()
  let releaseFirst!: () => void
  const firstDecision = new Promise<void>(resolve => { releaseFirst = resolve })
  let firstStarted!: () => void
  const firstReviewStarted = new Promise<void>(resolve => { firstStarted = resolve })
  let releaseOthers!: () => void
  const otherDecision = new Promise<void>(resolve => { releaseOthers = resolve })
  const pending: Array<Promise<unknown>> = []
  try {
    const first = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    const firstCommit = writes.commit(sessionId, { proposalId: first.proposalId }, agent, signal,
      async () => { firstStarted(); await firstDecision; return true })
    await firstReviewStarted
    const ready = []
    for (let index = 0; index < 127; index++) {
      ready.push(await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal))
    }
    const extra = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit(sessionId, { proposalId: ready[0]!.proposalId }, agent, signal,
      async () => true), { code: 'pdf/proposal-unavailable' })
    let started = 0
    let allStarted!: () => void
    const everyReviewStarted = new Promise<void>(resolve => { allStarted = resolve })
    for (const entry of [...ready.slice(1), extra]) {
      pending.push(writes.commit(sessionId, { proposalId: entry.proposalId }, agent, signal,
        async () => { if (++started === 127) allStarted(); await otherDecision; return false })
        .catch(error => error))
    }
    await everyReviewStarted
    await assert.rejects(writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal),
      { code: 'pdf/proposals-full' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    releaseOthers()
    await Promise.all(pending)
    releaseFirst()
    assert.equal((await firstCommit).status, 'committed', 'oldest busy proposal remains live')
    assert.equal(state.writes(), 0)
  } finally {
    releaseOthers?.()
    releaseFirst?.()
    await Promise.allSettled(pending)
    writes.dispose()
    await state.workspaces.dispose()
  }
})

test('disposing a model-write service during approval invalidates the proposal', async () => {
  const { state, opened, writes } = await fixture()
  try {
    const preview = await writes.preview(sessionId, proposal(opened.id, opened.revision), agent, signal)
    await assert.rejects(writes.commit(sessionId, { proposalId: preview.proposalId }, agent, signal,
      async () => { writes.dispose(); return true }), { code: 'pdf/proposal-unavailable' })
    assert.equal(state.workspaces.readSnapshot(sessionId, opened.id).revision, opened.revision)
    assert.equal(state.writes(), 0)
  } finally { writes.dispose(); await state.workspaces.dispose() }
})
