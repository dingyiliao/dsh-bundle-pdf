import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfAnnotation, PdfAnnotationOperation } from '../../../src/core/pdf-types.ts'
import type { ReaderSelection } from '../../../src/modules/viewer/model/reader-selection.ts'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { useReaderAnnotations, type ReaderAnnotationsOptions } from '../../../src/modules/viewer/index.ts'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

const existing: PdfAnnotation = {
  id: 'existing', page: 1, subtype: 'Highlight', rect: [10, 20, 50, 30],
  color: [1, 1, 0], contents: 'saved comment', flags: 4, supported: true, editable: true,
}

function snapshot(annotations: PdfAnnotation[] = []): WorkspaceSnapshot {
  return {
    id: 'doc-1', revision: 4,
    document: { readOnly: false, annotations,
      pages: [{ page: 1, cropBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }] },
  } as WorkspaceSnapshot
}

const textSelection: ReaderSelection = {
  revision: 4, kind: 'text', text: 'selected words',
  fragments: [{ page: 1, rect: [10, 20, 50, 30], quadPoints: [10, 30, 50, 30, 10, 20, 50, 20] }],
}

async function withAnnotations(run: (fixture: {
  state(): ReturnType<typeof useReaderAnnotations>
  options: ReaderAnnotationsOptions
  render(options: ReaderAnnotationsOptions): Promise<void>
  operations: PdfAnnotationOperation[][]
  selected(): ReaderSelection | null
  mode(): 'text' | 'region' | 'note'
}) => Promise<void>, initial = snapshot()): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const root = createRoot(dom.document.getElementById('root')!)
  let latest: ReturnType<typeof useReaderAnnotations> | undefined
  let current = initial
  let selection: ReaderSelection | null = null
  let mode: 'text' | 'region' | 'note' = 'text'
  const operations: PdfAnnotationOperation[][] = []
  const Harness = (props: ReaderAnnotationsOptions) => { latest = useReaderAnnotations(props); return null }
  const options: ReaderAnnotationsOptions = {
    snapshot: initial, pdfAnnotations: initial.document.annotations, selection,
    setSelection: value => { selection = typeof value === 'function' ? value(selection) : value },
    setMode: value => { mode = typeof value === 'function' ? value(mode) : value },
    ownerSequence: { current: 1 }, operationLock: { current: false },
    currentSnapshot: () => current,
    change: async next => { operations.push(next); return current },
    t: key => key,
  }
  const render = async (next: ReaderAnnotationsOptions) => {
    current = next.snapshot ?? current
    await act(async () => { root.render(React.createElement(Harness, next)) })
  }
  try {
    await render(options)
    await run({ state: () => latest!, options, render, operations,
      selected: () => selection, mode: () => mode })
  } finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('mark previews a selected text fragment, then commits the generated annotation', async () => {
  await withAnnotations(async ({ state, options, render, operations, selected }) => {
    let release: ((value: WorkspaceSnapshot) => void) | undefined
    const committed = new Promise<WorkspaceSnapshot>(resolve => { release = resolve })
    await render({ ...options, selection: textSelection,
      change: async next => { operations.push(next); return committed } })
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().mark('Highlight', '#ff8000'); await Promise.resolve() })
    assert.equal(state().pendingAnnotations.length, 1)
    assert.equal(state().displayAnnotations.length, 1)
    assert.deepEqual(state().pendingAnnotations[0].color, [1, 128 / 255, 0])
    assert.equal(selected(), null)
    assert.equal(operations[0][0].type, 'add')
    const annotation = state().pendingAnnotations[0]
    await act(async () => { release!(snapshot([annotation])); await pending })
    assert.equal(state().pendingAnnotations.length, 0)
    assert.equal(operations[0][0].type === 'add' && operations[0][0].annotation.id, annotation.id)
  })
})

test('failed mark removes the optimistic preview without claiming a saved annotation', async () => {
  await withAnnotations(async ({ state, options, render }) => {
    let release: ((value: undefined) => void) | undefined
    const committed = new Promise<undefined>(resolve => { release = resolve })
    await render({ ...options, selection: textSelection, change: async () => committed })
    let pending: Promise<void> | undefined
    await act(async () => { pending = state().mark('Underline'); await Promise.resolve() })
    assert.equal(state().pendingAnnotations.length, 1)
    await act(async () => { release!(undefined); await pending })
    assert.equal(state().pendingAnnotations.length, 0)
    assert.equal(state().displayAnnotations.length, 0)
    assert.equal(state().selectedAnnotation, undefined)
  })
})

test('selecting a mark with comments opens the read card; adding enters a separate draft', async () => {
  await withAnnotations(async ({ state, options, render, selected }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id))
    assert.equal(state().selectedAnnotation, existing.id)
    assert.equal(state().commentCardOpen, true)
    assert.equal(state().commentMode, 'read')
    assert.deepEqual(state().thread?.comments.map(item => item.id), [existing.id])
    await act(async () => state().openCommentEditor())
    assert.equal(state().commentCardOpen, true)
    assert.equal(state().commentMode, 'new')
    assert.equal(state().comment, '')
    assert.equal(selected(), null)
    await act(async () => state().setComment('draft edit'))
    assert.equal(state().hasUnappliedAnnotation, true)
    await act(async () => state().selectAnnotation(existing.id, 'comment'))
    assert.equal(state().comment, 'draft edit', 're-clicking the same mark must not throw away a draft')
    assert.equal(state().commentMode, 'new')
    const confirm = Object.getOwnPropertyDescriptor(window, 'confirm')
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => false })
    try {
      await act(async () => state().selectAnnotation('different'))
      assert.equal(state().selectedAnnotation, existing.id)
      await act(async () => state().clearAnnotation())
      assert.equal(state().selectedAnnotation, existing.id)
    } finally {
      if (confirm) Object.defineProperty(window, 'confirm', confirm)
    }
  })
})

test('comment marker opens read mode directly and closing it deselects without toolbar flash', async () => {
  await withAnnotations(async ({ state, options, render }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id, 'comment'))
    assert.equal(state().commentCardOpen, true)
    assert.equal(state().commentMode, 'read')
    assert.equal(state().comment, '')
    await act(async () => state().closeCommentEditor())
    assert.equal(state().commentCardOpen, false)
    assert.equal(state().selectedAnnotation, undefined)
    await act(async () => state().selectAnnotation(existing.id))
    assert.equal(state().commentCardOpen, true)
    assert.equal(state().selectedAnnotation, existing.id)
  })
})

test('a mark without comments opens only its toolbar until Add comment is chosen', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    const blank = { ...existing, contents: '' }
    await render({ ...options, snapshot: snapshot([blank]), pdfAnnotations: [blank] })
    await act(async () => state().selectAnnotation(blank.id))
    assert.equal(state().commentCardOpen, false)
    await act(async () => state().openCommentEditor())
    assert.equal(state().commentMode, 'new')
    await act(async () => state().setComment('first comment'))
    await act(async () => { await state().applyComment() })
    assert.deepEqual(operations, [[{ type: 'update', id: blank.id, patch: { contents: 'first comment' } }]])
    assert.equal(state().commentMode, 'read')
  })
})

test('locked marks only reopen saved comments and never offer a new draft', async () => {
  await withAnnotations(async ({ state, options, render }) => {
    const locked = { ...existing, editable: false }
    await render({ ...options, snapshot: snapshot([locked]), pdfAnnotations: [locked] })
    await act(async () => state().selectAnnotation(locked.id))
    await act(async () => state().dismissCommentCard())
    await act(async () => state().selectAnnotation(locked.id))
    await act(async () => state().openCommentEditor())
    assert.equal(state().commentMode, 'read')
    assert.equal(state().commentCardOpen, true)

    const blank = { ...locked, contents: '' }
    await render({ ...options, snapshot: snapshot([blank]), pdfAnnotations: [blank] })
    await act(async () => state().selectAnnotation(blank.id))
    await act(async () => state().openCommentEditor())
    assert.equal(state().commentCardOpen, false)
    assert.equal(state().commentMode, 'read')
  })
})

test('beginNote clamps a standalone note and opens its independent editor', async () => {
  await withAnnotations(async ({ state, mode }) => {
    await act(async () => state().beginNote(1, [150, -10]))
    assert.equal(state().pendingNote?.subtype, 'Text')
    assert.deepEqual(state().pendingNote?.rect, [80, 0, 100, 20])
    assert.equal(state().noteCardOpen, true)
    assert.equal(state().commentCardOpen, false)
    assert.equal(state().noteMode, 'new')
    assert.equal(state().hasUnappliedAnnotation, false, 'an empty note draft is not yet a document change')
    assert.equal(state().annotationColor, '#ffff00', 'standalone notes do not own markup color')
    assert.equal(mode(), 'text')
  })
})

test('moving an open draft note changes its anchor rectangle before it is saved', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await act(async () => state().beginNote(1, [10, 20]))
    const id = state().pendingNote!.id
    await act(async () => { assert.equal(await state().moveNote([22, 33, 42, 53]), true) })
    assert.equal(state().pendingNote?.id, id)
    assert.deepEqual(state().pendingNote?.rect, [22, 33, 42, 53])
    assert.deepEqual(operations, [], 'an unsaved note move stays in its local draft instead of writing early')
    assert.ok(options.snapshot)
  })
})

test('moving a saved markup comment card writes its page-space position', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id))
    assert.equal(state().canPersistCommentPosition, true)
    await act(async () => { assert.equal(await state().moveCommentCard([75, 120]), true) })
    assert.deepEqual(operations, [[{ type: 'update', id: existing.id, patch: { commentPosition: [75, 120] } }]])
  }, snapshot([existing]))
})

test('selecting a saved standalone note opens a note card, never a comment thread', async () => {
  const note: PdfAnnotation = { id: 'note', page: 1, subtype: 'Text', rect: [30, 40, 50, 60],
    contents: 'Read this later', flags: 4, supported: true, editable: true }
  await withAnnotations(async ({ state, options, render }) => {
    await render({ ...options, snapshot: snapshot([note]), pdfAnnotations: [note] })
    await act(async () => state().selectAnnotation(note.id, 'note'))
    assert.equal(state().selectedNote?.id, note.id)
    assert.equal(state().noteCardOpen, true)
    assert.equal(state().commentCardOpen, false)
    assert.equal(state().thread, undefined)
    assert.equal(state().noteText, 'Read this later')
  }, snapshot([note]))
})

test('standalone note edits can be cancelled, committed and deleted through the shared draft', async () => {
  const note: PdfAnnotation = { id: 'editable-note', page: 1, subtype: 'Text', rect: [30, 40, 50, 60],
    contents: 'Original', flags: 4, supported: true, editable: true }
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([note]), pdfAnnotations: [note] })
    await act(async () => state().selectAnnotation(note.id, 'note'))
    await act(async () => state().editNote())
    await act(async () => state().setNoteText('Discard this'))
    await act(async () => state().cancelNoteEdit())
    assert.equal(state().noteText, 'Original')
    assert.equal(state().noteMode, 'read')
    await act(async () => state().editNote())
    await act(async () => state().setNoteText('Revised'))
    await act(async () => { await state().applyNote() })
    assert.deepEqual(operations[0], [{ type: 'update', id: note.id, patch: { contents: 'Revised' } }])
    await act(async () => { await state().deleteNote() })
    assert.deepEqual(operations[1], [{ type: 'delete', id: note.id }])
    assert.equal(state().selectedAnnotation, undefined)
    assert.equal(state().noteCardOpen, false)
  }, snapshot([note]))
})

test('editing an existing comment updates only that entry and cancel restores read mode', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id))
    await act(async () => state().editComment(existing.id))
    assert.equal(state().comment, 'saved comment')
    assert.equal(state().commentMode, 'edit')
    await act(async () => state().setComment('updated note'))
    await act(async () => { await state().applyComment() })
    assert.deepEqual(operations, [[{ type: 'update', id: existing.id,
      patch: { contents: 'updated note' } }]])
    assert.equal(state().commentMode, 'read')
    await act(async () => state().editComment(existing.id))
    await act(async () => state().setComment('discard this'))
    await act(async () => state().closeCommentEditor())
    assert.equal(state().comment, '')
    assert.equal(state().commentCardOpen, true)
    assert.equal(state().selectedAnnotation, existing.id)
  })
})

test('adding another comment creates an independent PDF reply', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id))
    await act(async () => state().openCommentEditor())
    await act(async () => state().setComment('a second opinion'))
    await act(async () => { await state().applyComment() })
    const operation = operations[0]?.[0]
    assert.equal(operation?.type, 'add')
    if (operation?.type !== 'add') return
    assert.equal(operation.annotation.replyToId, existing.id)
    assert.equal(operation.annotation.subtype, 'Text')
    assert.equal(operation.annotation.contents, 'a second opinion')
    assert.equal(state().commentMode, 'read')
  })
})

test('editing imported rich text requires confirmation before plain-text conversion', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    const imported = { ...existing, hasRichText: true as const }
    await render({ ...options, snapshot: snapshot([imported]), pdfAnnotations: [imported] })
    await act(async () => state().selectAnnotation(imported.id))
    await act(async () => state().editComment(imported.id))
    await act(async () => state().setComment('Plain text edit'))
    const prior = Object.getOwnPropertyDescriptor(window, 'confirm')
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => false })
    try {
      await act(async () => { await state().applyComment() })
      assert.deepEqual(operations, [])
      assert.equal(state().comment, 'Plain text edit')
    } finally {
      if (prior) Object.defineProperty(window, 'confirm', prior)
    }
  })
})

test('external nested replies form one thread and one sidebar root', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    const first = { ...existing, id: 'reply-1', subtype: 'Text', replyToId: existing.id,
      contents: 'Alice replies', author: 'Alice' }
    const second = { ...existing, id: 'reply-2', subtype: 'Text', replyToId: first.id,
      contents: 'Bob follows up', author: 'Bob' }
    await render({ ...options, snapshot: snapshot([existing, first, second]), pdfAnnotations: [existing, first, second] })
    assert.deepEqual(state().annotationItems.map(item => item.id), [existing.id])
    await act(async () => state().selectAnnotation(second.id, 'comment'))
    assert.equal(state().selectedAnnotation, existing.id)
    assert.deepEqual(state().thread?.comments.map(item => item.id), [existing.id, first.id, second.id])
    await act(async () => state().editComment(second.id))
    await act(async () => state().setComment('edited reply'))
    await act(async () => { await state().applyComment() })
    assert.deepEqual(operations, [[{ type: 'update', id: second.id, patch: { contents: 'edited reply' } }]])
  })
})

test('deleting comments clears only root contents or one reply without removing the mark', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    const reply = { ...existing, id: 'reply', subtype: 'Text', replyToId: existing.id,
      contents: 'another comment' }
    await render({ ...options, snapshot: snapshot([existing, reply]), pdfAnnotations: [existing, reply] })
    await act(async () => state().selectAnnotation(existing.id))
    await act(async () => { await state().deleteComment(existing.id) })
    await act(async () => { await state().deleteComment(reply.id) })
    assert.deepEqual(operations, [
      [{ type: 'update', id: existing.id, patch: { contents: '' } }],
      [{ type: 'delete', id: reply.id }],
    ])
  })
})

test('a reply with child replies cannot be deleted from the card', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    const parent = { ...existing, id: 'reply-parent', subtype: 'Text', replyToId: existing.id,
      contents: 'Parent reply' }
    const child = { ...existing, id: 'reply-child', subtype: 'Text', replyToId: parent.id,
      contents: 'Child reply' }
    await render({ ...options, snapshot: snapshot([existing, parent, child]), pdfAnnotations: [existing, parent, child] })
    await act(async () => state().selectAnnotation(existing.id))
    await act(async () => { await state().deleteComment(parent.id) })
    assert.deepEqual(operations, [])
    await act(async () => { await state().deleteComment(child.id) })
    assert.deepEqual(operations, [[{ type: 'delete', id: child.id }]])
  })
})

test('pending page note is added independently without an annotation color', async () => {
  await withAnnotations(async ({ state, operations }) => {
    await act(async () => state().beginNote(1, [30, 40]))
    const id = state().pendingNote!.id
    await act(async () => state().setNoteText('new note'))
    await act(async () => { await state().applyNote() })
    assert.equal(operations[0][0]?.type, 'add')
    assert.equal(operations[0][0]?.type === 'add' && operations[0][0].annotation.id, id)
    assert.equal(operations[0][0]?.type === 'add' && operations[0][0].annotation.contents, 'new note')
    assert.equal(operations[0][0]?.type === 'add' && operations[0][0].annotation.color, undefined)
    assert.equal(state().pendingNote, null)
    assert.equal(state().noteMode, 'read')
    assert.equal(state().noteCardOpen, true)
    assert.equal(state().commentCardOpen, false)
  })
})

test('standalone notes reject markup-color updates', async () => {
  const note: PdfAnnotation = { ...existing, id: 'note', subtype: 'Text', color: undefined, contents: 'A note' }
  await withAnnotations(async ({ state, options, render }) => {
    await render({ ...options, snapshot: snapshot([note]), pdfAnnotations: [note] })
    await act(async () => state().selectAnnotation(note.id))
    options.operationLock.current = true
    await act(async () => state().updateColor('#123456'))
    assert.equal(state().annotationColor, '#ffff00')
    assert.equal(state().color, '#ffff00')
    assert.equal(state().noteCardOpen, true)
    await act(async () => state().resetResource())
    options.operationLock.current = false
  }, snapshot([note]))
})

test('standalone note color changes persist independently of markup color', async () => {
  const note: PdfAnnotation = { ...existing, id: 'note-color', subtype: 'Text',
    color: [1, 0.85, 0], contents: 'A note' }
  await withAnnotations(async ({ state, operations }) => {
    await act(async () => state().selectAnnotation(note.id))
    await act(async () => state().updateNoteColor('#ff99aa'))
    assert.equal(state().noteColor, '#ff99aa')
    assert.equal(state().annotationColor, '#ffff00')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    assert.deepEqual(operations, [[{ type: 'update', id: note.id,
      patch: { color: [1, 153 / 255, 170 / 255] } }]])
  }, snapshot([note]))
})

test('failed note recoloring restores its saved color', async () => {
  const note: PdfAnnotation = { ...existing, id: 'failed-note-color', subtype: 'Text',
    color: [1, 0.85, 0], contents: 'A note' }
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([note]), pdfAnnotations: [note],
      change: async next => { operations.push(next); return undefined } })
    await act(async () => state().selectAnnotation(note.id))
    await act(async () => state().updateNoteColor('#3366cc'))
    assert.equal(state().noteColor, '#3366cc')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    assert.equal(state().noteColor, '#ffd900')
    assert.equal(state().colorPending, false)
    assert.equal(operations.length, 1)
  }, snapshot([note]))
})

test('failed color write restores the saved color and removes its unload guard', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    let finishWrite!: () => void
    const writeFinished = new Promise<void>(resolve => { finishWrite = resolve })
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing],
      change: async next => { operations.push(next); await writeFinished; return undefined } })
    await act(async () => state().selectAnnotation(existing.id))
    await act(async () => state().updateColor('#ff8000'))
    assert.equal(state().annotationColor, '#ff8000')
    assert.equal(state().colorPending, true)
    const before = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(before)
    assert.equal(before.defaultPrevented, true)
    finishWrite()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    assert.deepEqual(operations, [[{ type: 'update', id: existing.id, patch: { color: [1, 128 / 255, 0] } }]])
    assert.equal(state().annotationColor, '#ffff00')
    assert.equal(state().colorPending, false)
    const after = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    assert.equal(after.defaultPrevented, false)
  }, snapshot([existing]))
})

test('resource reset discards queued color changes before a locked operation can flush them', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id))
    options.operationLock.current = true
    await act(async () => state().updateColor('#00ff00'))
    assert.equal(state().colorPending, true)
    await act(async () => state().resetResource())
    assert.equal(state().colorPending, false)
    assert.equal(state().selectedAnnotation, undefined)
    assert.equal(state().commentCardOpen, false)
    options.operationLock.current = false
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    assert.deepEqual(operations, [])
  }, snapshot([existing]))
})

test('mark rejects stale and region selections without mutating the document', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, selection: { ...textSelection, revision: 3 } })
    await act(async () => state().mark('Highlight'))
    await render({ ...options, selection: { ...textSelection, kind: 'region' } })
    await act(async () => state().mark('Highlight'))
    assert.deepEqual(operations, [])
    assert.equal(state().pendingAnnotations.length, 0)
  })
})

test('deleting a selected editable annotation clears its open comment card', async () => {
  await withAnnotations(async ({ state, options, render, operations }) => {
    await render({ ...options, snapshot: snapshot([existing]), pdfAnnotations: [existing] })
    await act(async () => state().selectAnnotation(existing.id))
    await act(async () => state().deleteAnnotation())
    assert.deepEqual(operations, [[{ type: 'delete', id: existing.id }]])
    assert.equal(state().selectedAnnotation, undefined)
    assert.equal(state().commentCardOpen, false)
  }, snapshot([existing]))
})
