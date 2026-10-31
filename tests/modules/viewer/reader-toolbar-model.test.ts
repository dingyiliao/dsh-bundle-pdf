import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkspaceSnapshot } from '../../../src/shared/contracts.ts'
import { readerToolbarModel, type ReaderToolbarModelOptions } from '../../../src/modules/viewer/controllers/reader-toolbar-model.ts'
import { readerFloatingStatuses, readerModeStatus, type ReaderFloatingStatusesOptions } from '../../../src/modules/viewer/controllers/reader-floating-statuses.ts'

function toolbarFixture() {
  const calls: string[] = []
  const snapshot = { id: 'doc', revision: 2, dirty: false, canRedo: false } as WorkspaceSnapshot
  const api = {
    async reload() { calls.push('reload'); return snapshot },
    async undo() { calls.push('undo'); return snapshot },
    async redo() { calls.push('redo'); return snapshot },
  } as unknown as ReaderToolbarModelOptions['api']
  const options: ReaderToolbarModelOptions = {
    snapshot, sessionId: 'session', signal: new AbortController().signal, api,
    act: async operation => operation(snapshot), busy: false, editable: true,
    colorPending: false, saveAsPicking: false, hasUnappliedAnnotation: false,
    explanation: { allowed: true, active: false, sending: false,
      start: () => calls.push('explain-start'), cancel: () => calls.push('explain-cancel') },
    screenshot: { active: false, preparing: false, begin: () => calls.push('screenshot'),
      canPlaceNote: () => true, clearRegionPurpose: () => calls.push('clear-region') },
    ocr: { busy: false, availability: { status: 'available' },
      refresh: () => calls.push('ocr-refresh'), recognize: () => calls.push('ocr') },
    navigation: { canGoBack: true, navigating: false, history: { revision: 0, positions: [] }, fit: 'width', zoom: 1,
      back: (depth, revision) => calls.push(`back:${depth ?? ''}:${revision ?? ''}`),
      canZoom: () => true, setFit: value => calls.push(`fit:${value}`),
      setZoom: value => calls.push(`zoom:${value}`) },
    commands: { clearSelection: () => calls.push('clear-selection'),
      clearAnnotation: () => calls.push('clear-annotation'), setMode: value => calls.push(`mode:${value}`),
      closeMenu: () => calls.push('close-menu'), confirmReload: () => calls.push('confirm-reload'),
      beginSaveAs: () => calls.push('save-as'), discardChanges: () => calls.push('discard'),
      save: () => calls.push('save') },
  }
  return { options, calls }
}

test('toolbar model derives visual capabilities from live document and command state', () => {
  const { options } = toolbarFixture()
  const { state } = readerToolbarModel({ ...options, snapshot: { ...options.snapshot!, dirty: true,
    canUndo: true, conflict: true }, colorPending: true })
  assert.equal(state.hasDocument, true)
  assert.equal(state.canPromptExplanation, true)
  assert.equal(state.dirty, true)
  assert.equal(state.canUndo, true)
  assert.equal(state.conflict, true)
  assert.equal(state.colorPending, true)
})

test('toolbar commands preserve note gating, zoom lock and dirty reload confirmation', async () => {
  const { options, calls } = toolbarFixture()
  const model = readerToolbarModel(options)
  model.actions.onNote()
  model.actions.onZoom(1.25)
  model.actions.onReload()
  await Promise.resolve()
  assert.deepEqual(calls, ['clear-region', 'clear-selection', 'clear-annotation', 'mode:note', 'close-menu',
    'fit:custom', 'zoom:1.25', 'reload', 'close-menu'])
  calls.length = 0
  const locked = readerToolbarModel({ ...options, snapshot: { ...options.snapshot!, dirty: true },
    screenshot: { ...options.screenshot, canPlaceNote: () => false },
    navigation: { ...options.navigation, canZoom: () => false } })
  locked.actions.onNote()
  locked.actions.onZoom('page')
  locked.actions.onReload()
  assert.deepEqual(calls, ['confirm-reload', 'close-menu'])
})

test('toolbar back target and active explanation route to their owners', () => {
  const { options, calls } = toolbarFixture()
  const actions = readerToolbarModel({ ...options,
    explanation: { ...options.explanation, active: true } }).actions
  actions.onToggleExplanation()
  actions.onBackTo(2, 7)
  actions.onBack()
  assert.deepEqual(calls, ['explain-cancel', 'back:2:7', 'close-menu', 'back::'])
})

test('toolbar reload confirms staged form input before a clean snapshot can be replaced', () => {
  const { options, calls } = toolbarFixture()
  const model = readerToolbarModel({ ...options, formPending: true })
  model.actions.onReload()
  assert.deepEqual(calls, ['confirm-reload', 'close-menu'])
  assert.equal(model.state.formPending, true)
})

function floatingFixture(): ReaderFloatingStatusesOptions {
  return {
    saveFeedback: null, documentPath: '/document.pdf', mode: 'text', explanationActive: false,
    regionPurpose: null, screenshotPhase: null, ocrProgress: null,
    onSaveExpired() {}, onExitNote() {}, onCancelScreenshot() {}, onCancelOcr() {}, t: key => key,
  }
}

test('activity statuses preserve save occurrence while input modes stay separate', () => {
  const expired: number[] = []
  const statuses = readerFloatingStatuses({ ...floatingFixture(), mode: 'note',
    saveFeedback: { kind: 'saved', durationMs: 2000, occurrence: 9 },
    ocrProgress: 'recognizing', onSaveExpired: occurrence => expired.push(occurrence) })
  assert.deepEqual(statuses.map(item => item.id), ['save', 'ocr'])
  const mode = readerModeStatus({ ...floatingFixture(), mode: 'note' })
  assert.equal(mode?.kind, 'note')
  assert.equal(mode?.label, 'reader.placeNote')
  assert.equal(statuses[0].title, '/document.pdf')
  assert.equal(statuses[0].content, 'reader.saved')
  assert.equal(statuses[0].tone, 'success')
  statuses[0].onExpire?.()
  assert.deepEqual(expired, [9])
  assert.equal(statuses[1].actions?.[0].disabled, false)
})

test('explanation sends and failures stay in the shared task entry after exiting the mode', () => {
  let reviewed = 0, dismissed = 0
  const owner = { sending: true, error: '', review: () => { reviewed++ }, dismiss: () => { dismissed++ } }
  const progress = readerFloatingStatuses({ ...floatingFixture(), explanationActive: false, explanation: owner })
  assert.equal(progress[0].id, 'explanation')
  assert.equal(progress[0].activity, 'progress')
  const failed = readerFloatingStatuses({ ...floatingFixture(), explanationActive: false,
    explanation: { ...owner, sending: false, error: 'Could not append the turn' } })
  assert.equal(failed[0].content, 'Could not append the turn')
  assert.equal(failed[0].tone, 'error')
  failed[0].actions?.[0].onClick()
  failed[0].actions?.[1].onClick()
  assert.deepEqual([reviewed, dismissed], [1, 1], 'review and dismiss return to the original controller owner')
})

test('saving and unsaved feedback use progress and neutral semantics', () => {
  const saving = readerFloatingStatuses({ ...floatingFixture(), saveFeedback: { kind: 'saving', durationMs: 0, occurrence: 1 } })
  const unsaved = readerFloatingStatuses({ ...floatingFixture(), saveFeedback: { kind: 'unsaved', durationMs: 0, occurrence: 2 } })
  assert.equal(saving[0].tone, 'progress')
  assert.equal(unsaved[0].tone, 'neutral')
})

test('a failed save remains an error task until its owner clears the feedback', () => {
  const statuses = readerFloatingStatuses({ ...floatingFixture(),
    saveFeedback: { kind: 'failed', durationMs: 0, occurrence: 3, path: '/failed.pdf' } })
  assert.equal(statuses[0].id, 'save')
  assert.equal(statuses[0].kind, 'error')
  assert.equal(statuses[0].tone, 'error')
  assert.equal(statuses[0].content, 'reader.saveFailed')
  assert.equal(statuses[0].durationMs, 0)
  assert.equal(statuses[0].title, '/failed.pdf')
  assert.deepEqual(readerFloatingStatuses(floatingFixture()), [])
})

test('floating statuses suppress conflicting mode hints and disable cancel while stopping', () => {
  const statuses = readerFloatingStatuses({ ...floatingFixture(), mode: 'region',
    regionPurpose: 'screenshot', explanationActive: true, screenshotPhase: 'cancelling',
    ocrProgress: 'cancelling' })
  assert.deepEqual(statuses.map(item => item.id), ['screenshot', 'ocr'])
  assert.equal(readerModeStatus({ ...floatingFixture(), mode: 'region', regionPurpose: 'screenshot',
    explanationActive: true }), null)
  assert.equal(readerModeStatus({ ...floatingFixture(), mode: 'region', regionPurpose: 'screenshot' })?.kind, 'region')
  assert.equal(statuses[0].actions?.[0].disabled, true)
  assert.equal(statuses[1].actions?.[0].disabled, true)
})
