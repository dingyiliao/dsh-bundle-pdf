import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import type { PdfAnnotation } from '../../../src/core/pdf-types.ts'
import { ReaderCommentEditor, type ReaderCommentEditorProps } from '../../../src/modules/viewer/components/ReaderCommentEditor.tsx'

const project = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const testRequire = createRequire(import.meta.url)
const { JSDOM } = testRequire('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis & { close(): void } }
}

async function withEditor(run: (fixture: {
  container: HTMLElement
  props: ReaderCommentEditorProps
  render(props: ReaderCommentEditorProps): Promise<void>
  actions: string[]
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' }).window
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const container = dom.document.getElementById('root')!
  const root = createRoot(container)
  const actions: string[] = []
  const props: ReaderCommentEditorProps = {
    comments: [], mode: 'new', editable: true, readOnly: false,
    comment: '', textarea: createRef<HTMLTextAreaElement>(),
    onComment: value => actions.push(`comment:${value}`),
    onAdd: () => actions.push('add'), onEdit: id => actions.push(`edit:${id}`),
    onDeleteComment: id => actions.push(`delete:${id}`), onApply: () => actions.push('apply'),
    onClose: () => actions.push('close'), onDismiss: () => actions.push('dismiss'), t: key => key,
  }
  const render = async (next: ReaderCommentEditorProps) => {
    await act(async () => root.render(React.createElement(ReaderCommentEditor, next)))
  }
  try { await render(props); await run({ container, props, render, actions }) }
  finally {
    await act(async () => root.unmount())
    dom.close()
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('comment card reads multiple entries with author/date and edits each independently', async () => {
  await withEditor(async ({ container, props, render, actions }) => {
    const selected = { id: 'a', page: 1, subtype: 'Highlight', rect: [0, 0, 10, 10],
      supported: true, editable: true, color: [1, 1, 0], author: 'Alice', contents: 'First comment',
      createdAt: '2026-10-01T00:00:00.000Z', modifiedAt: '2026-10-02T00:00:00.000Z' } as PdfAnnotation
    const reply = { ...selected, id: 'reply', replyToId: 'a', author: 'Bob', contents: 'Second comment' }
    await render({ ...props, comments: [selected, reply], mode: 'read' })
    assert.equal(container.querySelector('textarea'), null)
    assert.equal(container.querySelectorAll('.dsh-pdf-comment-message').length, 2)
    assert.match(container.textContent ?? '', /Alice/)
    assert.match(container.textContent ?? '', /Bob/)
    assert.match(container.textContent ?? '', /First comment/)
    assert.match(container.textContent ?? '', /Second comment/)
    assert.ok(container.querySelector('time[dateTime]'))
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="reader.editComment: Bob"]')!.click()
      container.querySelector<HTMLButtonElement>('[aria-label="reader.deleteComment: Alice"]')!.click()
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      buttons.find(button => button.textContent === 'reader.addComment')!.click()
    })
    assert.deepEqual(actions, ['edit:reply', 'delete:a', 'add'])
    await render({ ...props, comments: [selected, reply], mode: 'edit', editingCommentId: 'reply', comment: 'Edit' })
    assert.equal(container.querySelectorAll('textarea').length, 1)
    assert.equal(container.querySelector<HTMLTextAreaElement>('textarea')?.value, 'Edit')
    await act(async () => {
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
      buttons.find(button => button.textContent === 'reader.saveComment')!.click()
    })
    assert.deepEqual(actions, ['edit:reply', 'delete:a', 'add', 'apply'])
  })
})

test('read-only imported replies remain visible without edit controls', async () => {
  await withEditor(async ({ container, props, render, actions }) => {
    const selected = { id: 'a', page: 1, subtype: 'Text', rect: [0, 0, 10, 10],
      supported: true, editable: false, color: [1, 1, 0], readOnlyReason: 'signed-document',
      contents: 'Imported comment', author: 'Someone' } as PdfAnnotation
    await render({ ...props, comments: [selected], mode: 'read', readOnly: true })
    assert.equal(container.querySelector('textarea'), null)
    assert.equal(container.querySelector('[aria-label^="reader.editComment"]'), null)
    assert.match(container.textContent ?? '', /reader.reason.signed-document/)
    await act(async () => container.firstElementChild!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.deepEqual(actions, ['close'])
  })
})

test('new comment composer requires only text, and close is distinct from cancel', async () => {
  await withEditor(async ({ container, props, render, actions }) => {
    await render(props)
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-comment-editor-apply')?.disabled, true)
    assert.equal(container.querySelector('input[type=color]'), null)
    await render({ ...props, comment: 'A comment' })
    assert.equal(container.querySelector<HTMLButtonElement>('.dsh-pdf-comment-editor-apply')?.disabled, false)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.dsh-pdf-comment-editor-cancel')!.click()
      container.querySelector<HTMLButtonElement>('.dsh-pdf-comment-editor-close')!.click()
    })
    assert.deepEqual(actions, ['close', 'dismiss'])
  })
})

test('a reply with descendants displays why its Delete action is unavailable', async () => {
  await withEditor(async ({ container, props, render }) => {
    const root = { id: 'root', page: 1, subtype: 'Highlight', flags: 4,
      supported: true, editable: true, contents: 'Root' } as PdfAnnotation
    const reply = { ...root, id: 'reply', subtype: 'Text', replyToId: root.id, contents: 'Reply' }
    const child = { ...root, id: 'child', subtype: 'Text', replyToId: reply.id, contents: 'Child' }
    await render({ ...props, comments: [root, reply, child], blockedDeleteIds: new Set(['reply']), mode: 'read' })
    const button = container.querySelector<HTMLButtonElement>('[data-comment-id="reply"] .dsh-pdf-comment-editor-delete')
    assert.equal(button?.disabled, true)
    assert.equal(button?.title, 'reader.commentHasReplies')
  })
})

test('editing imported rich text explains the irreversible plain-text conversion', async () => {
  await withEditor(async ({ container, props, render }) => {
    const imported = { id: 'rich', page: 1, subtype: 'Highlight', flags: 4, supported: true,
      editable: true, contents: 'Formatted', hasRichText: true } as PdfAnnotation
    await render({ ...props, comments: [imported], mode: 'edit',
      editingCommentId: imported.id, comment: 'Changed' })
    assert.match(container.querySelector('[role="note"]')?.textContent ?? '', /reader.richTextConversionWarning/)
  })
})
