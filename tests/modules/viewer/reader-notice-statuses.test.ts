import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { readerNoticeStatuses, type ReaderNoticeStatusesOptions } from '../../../src/surfaces/client/viewer/controllers/reader-floating-statuses.ts'

function snapshot(document: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): WorkspaceSnapshot {
  return {
    id: 'document', path: '/book.pdf', sourceVersion: 'source-1', contentVersion: 'content-1', revision: 0,
    dirty: false, canUndo: false, canRedo: false, conflict: false,
    document: { readOnly: false, encrypted: false, ...document }, reader: {}, ...extra,
  } as unknown as WorkspaceSnapshot
}

function options(overrides: Partial<ReaderNoticeStatusesOptions> = {}): ReaderNoticeStatusesOptions {
  return {
    snapshot: null, error: '', positionNotice: '', editable: true, saveAsOpen: false,
    editPasswordRequired: false, editPasswordPromptOpen: false,
    dismissError() {}, dismissPositionNotice() {}, beginEditUnlock() {}, beginSaveAs() {},
    t: key => key, ...overrides,
  }
}

test('document signature and source warnings are exposed through persistent status entries', () => {
  const statuses = readerNoticeStatuses(options({
    snapshot: snapshot({ readOnly: true, readOnlyReason: 'signed-document' }, { warning: 'Saving invalidates signatures' }),
  }))
  assert.deepEqual(statuses.map(status => status.id), ['document-read-only', 'document-warning'])
  assert.equal(statuses[0]?.content, 'reader.documentReadOnly')
  assert.equal(statuses[1]?.content, 'Saving invalidates signatures')
  assert.ok(statuses.every(status => status.durationMs === undefined))
})

test('signature-risk copy is routed to the rail without duplicating read-only notices', () => {
  const uncertain = readerNoticeStatuses(options({ snapshot: snapshot({ signatureUncertain: true }) }))
  assert.equal(uncertain[0]?.id, 'document-signature')
  assert.equal(uncertain[0]?.content, 'reader.signaturePossible')
  const signed = readerNoticeStatuses(options({ snapshot: snapshot({ signed: true }) }))
  assert.equal(signed[0]?.content, 'reader.signatureEditable')
  const certified = readerNoticeStatuses(options({ snapshot: snapshot({ signed: true, certificationPermission: 1 }) }))
  assert.equal(certified[0]?.content, 'reader.signatureCertified')
  const readOnly = readerNoticeStatuses(options({ snapshot: snapshot({ readOnly: true, signatureUncertain: true }) }))
  assert.deepEqual(readOnly.map(status => status.id), ['document-read-only'])
  assert.equal(readOnly[0]?.content, 'reader.documentReadOnly')
})

test('read-only, conflict, error, and position feedback retain their actions in the rail', () => {
  let dismissedErrors = 0
  let dismissedPositions = 0
  let savedAs = 0
  const statuses = readerNoticeStatuses(options({
    snapshot: snapshot({ readOnly: true, readOnlyReason: 'encrypted-document', encrypted: true, annotationEditing: 'allowed' },
      { conflict: true }),
    error: 'Open failed', positionNotice: 'Position unavailable', editable: false,
    dismissError: () => { dismissedErrors++ }, dismissPositionNotice: () => { dismissedPositions++ },
    beginSaveAs: () => { savedAs++ },
  }))
  assert.deepEqual(statuses.map(status => status.id), [
    'document-read-only', 'document-annotation-editable', 'reader-error', 'position-notice', 'document-conflict',
  ])
  assert.equal(statuses[0]?.content, 'reader.encryptedReadOnly')
  assert.equal(statuses[1]?.content, 'reader.encryptedAnnotationEditable')
  assert.equal(statuses[2]?.content, 'Open failed')
  statuses[2]?.dismiss?.onClick()
  statuses[3]?.dismiss?.onClick()
  assert.equal(dismissedErrors, 1)
  assert.equal(dismissedPositions, 1)
  const saveAs = statuses[4]?.actions?.[0]
  assert.equal(saveAs?.label, 'reader.saveAs')
  assert.equal(saveAs?.disabled, true)
  saveAs?.onClick()
  assert.equal(savedAs, 1)
})

test('encrypted edit unlock action stays with its status until the password prompt is open', () => {
  let unlocks = 0
  const baseSnapshot = snapshot({ readOnly: true, readOnlyReason: 'encrypted-document', encrypted: true,
    annotationEditing: 'owner-password-required' })
  const statuses = readerNoticeStatuses(options({ snapshot: baseSnapshot, editPasswordRequired: true,
    beginEditUnlock: () => { unlocks++ } }))
  assert.equal(statuses[0]?.content, 'reader.encryptedAnnotationLocked')
  assert.equal(statuses[0]?.actions?.[0]?.label, 'reader.unlockEditing')
  statuses[0]?.actions?.[0]?.onClick()
  assert.equal(unlocks, 1)
  const promptOpen = readerNoticeStatuses(options({ snapshot: baseSnapshot, editPasswordRequired: true, editPasswordPromptOpen: true }))
  assert.equal(promptOpen[0]?.actions, undefined)
})

test('Save As owns its error while open instead of duplicating it in the status rail', () => {
  const statuses = readerNoticeStatuses(options({ error: 'Target changed', saveAsOpen: true }))
  assert.deepEqual(statuses, [])
})
