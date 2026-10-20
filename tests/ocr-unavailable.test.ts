import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHostOcrApi } from '../src/adapters/client/remote/host-ocr-api.ts'
import { Settings, settingsLocales, type ConfigForm, type ConfigFormSnapshot } from '../src/client/Settings.tsx'
import { defaultSettings } from '../src/shared/contracts.ts'

test('global PDF settings explain Host-controlled OCR instead of showing a permanently disabled switch', () => {
  const snapshot: ConfigFormSnapshot = {
    status: 'ready', value: { ...defaultSettings }, base: {}, user: {}, revision: 1,
    writable: true,
  }
  const form: ConfigForm = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const html = renderToStaticMarkup(React.createElement(Settings, {
    form, t: key => (settingsLocales.en as Record<string, string>)[key] ?? key,
    translationEngines: [{ id: 'dsh-model', label: 'DSH model' }],
  }))
  assert.match(html, /reader asks the Host/)
  assert.doesNotMatch(html, /role="switch"/)
  assert.doesNotMatch(html, /Unavailable for now/)
})

test('the Client takes OCR availability from the authenticated Host for the owning session', async () => {
  const calls: { path: string; method: string; payload: object; signal?: AbortSignal }[] = []
  let status: 'available' | 'unavailable' = 'unavailable'
  const lifetime = new AbortController()
  const api = createHostOcrApi({ rpc: { async call(path, method, payload, signal) {
    calls.push({ path, method, payload, signal })
    return { ok: true, value: { status, ...(status === 'available'
      ? { descriptor: { id: 'session-llm', name: 'Current session model', version: '1',
        execution: 'remote', geometry: [], confidence: false } }
      : { reason: 'The selected model has no declared image-input capability.' }) } }
  } } }, lifetime.signal)
  const signal = new AbortController()

  assert.equal((await api.availability('session-1', signal.signal)).status, 'unavailable')
  status = 'available'
  const availability = await api.availability('session-1', signal.signal)
  assert.equal(availability.status, 'available')
  assert.deepEqual(calls.map(({ path, method, payload }) => ({ path, method, payload })), [
    { path: '/api', method: 'pdf.ocr', payload: { action: 'availability', sessionId: 'session-1' } },
    { path: '/api', method: 'pdf.ocr', payload: { action: 'availability', sessionId: 'session-1' } },
  ])
  assert.ok(calls.every(call => call.signal && !call.signal.aborted))
  signal.abort()
  assert.ok(calls.every(call => call.signal?.aborted))
})

test('the Client treats an OCR Host rejection as a failure, not an available model', async () => {
  const api = createHostOcrApi({ rpc: { async call() {
    return { ok: false, error: { code: 'engine-unavailable', message: 'The OCR backend was removed.' } }
  } } }, new AbortController().signal)
  await assert.rejects(api.availability('session-1', new AbortController().signal), /OCR backend was removed/)
})

test('the Client asks the Host to OCR a PDF region without uploading image bytes', async () => {
  const calls: { method: string; payload: object }[] = []
  const api = createHostOcrApi({ rpc: { async call(_path, method, payload) {
    calls.push({ method, payload })
    return { ok: true, value: {
      documentId: 'document-1', page: 3, revision: 7, contentVersion: 'v2',
      text: 'Visible text', status: 'complete', source: { backendId: 'session-llm', backendVersion: '1' },
      image: { width: 900, height: 120, pdfRegion: [20, 40, 180, 60] },
      geometry: { status: 'none', positionedParts: 0, totalParts: 1, pdfCoordinatesAvailable: false },
      blocks: [{ id: 'text', text: 'Visible text', box: null, confidence: null }],
      lines: [], words: [], coverage: [], warnings: ['geometry-unavailable'],
    } }
  } } }, new AbortController().signal)

  const result = await api.recognize({ sessionId: 'session-1', documentId: 'document-1', page: 3,
    region: [20, 40, 180, 60] }, new AbortController().signal)
  assert.equal(result.text, 'Visible text')
  assert.equal(result.geometry.status, 'none')
  assert.deepEqual(calls, [{ method: 'pdf.ocr', payload: { action: 'recognize', sessionId: 'session-1',
    documentId: 'document-1', page: 3, region: [20, 40, 180, 60] } }])
})
