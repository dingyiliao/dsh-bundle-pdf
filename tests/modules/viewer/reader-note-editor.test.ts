import assert from 'node:assert/strict'
import test from 'node:test'
import React, { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReaderNoteEditor, type ReaderNoteEditorProps } from '../../../src/modules/viewer/components/ReaderNoteEditor.tsx'

function props(overrides: Partial<ReaderNoteEditorProps> = {}): ReaderNoteEditorProps {
  return {
    mode: 'new', readOnly: false, editable: true, value: '', textarea: createRef<HTMLTextAreaElement>(),
    onChange() {}, onEdit() {}, onSave() {}, onCancel() {}, onDismiss() {}, onDelete() {}, t: key => key,
    ...overrides,
  }
}

test('new note editor requires text and presents note-specific actions', () => {
  const html = renderToStaticMarkup(React.createElement(ReaderNoteEditor, props()))
  assert.match(html, /data-icon="note"/)
  assert.match(html, /reader\.writeNote/)
  assert.match(html, /reader\.saveNote/)
  assert.match(html, /disabled=""/)
  assert.doesNotMatch(html, /reader\.comments|reader\.commentText/)
})

test('saved note editor displays one standalone note with edit affordance', () => {
  const note = { id: 'note-1', page: 1, subtype: 'Text', contents: 'Keep this thought', author: 'DSH',
    flags: 4, supported: true, editable: true }
  const html = renderToStaticMarkup(React.createElement(ReaderNoteEditor, props({
    note, mode: 'read', value: note.contents,
  })))
  assert.match(html, /Keep this thought/)
  assert.match(html, /DSH/)
  assert.match(html, /reader\.editNote/)
  assert.match(html, /reader\.moveNoteCard/)
  assert.match(html, /reader\.delete/)
  assert.doesNotMatch(html, /reader\.comments|dsh-pdf-comment-thread|reader\.annotationColor/)
})
