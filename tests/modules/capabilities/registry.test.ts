import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CapabilityRegistry, pdfCapabilities, requiredPdfOpenCapabilities } from '../../../src/modules/capabilities/index.ts'

test('PDF probe names the operations needed for each document feature', () => {
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 0, signatureCount: 0 }), [pdfCapabilities.renderPage])
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 1, signatureCount: 0 }),
    [pdfCapabilities.renderPage, pdfCapabilities.renderAcroForm])
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 1, signatureCount: 0 }, 'acroform'),
    [pdfCapabilities.renderPage, pdfCapabilities.renderAcroForm])
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 1, signatureCount: 0 }, 'xfa'),
    [pdfCapabilities.renderPage, pdfCapabilities.renderXfa, pdfCapabilities.renderAcroForm])
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 0, signatureCount: 0 }, 'acroform'),
    [pdfCapabilities.renderPage, pdfCapabilities.renderAcroForm])
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 2, signatureCount: 1 }),
    [pdfCapabilities.renderPage, pdfCapabilities.renderXfa, pdfCapabilities.previewSigned])
  assert.deepEqual(requiredPdfOpenCapabilities({ pageCount: 1, formType: 17, signatureCount: 0 }),
    [pdfCapabilities.renderPage, 'pdf.form.unknown-17.render'])
})

test('capability selection honors availability, priority and the actual renderer', async () => {
  const registry = new CapabilityRegistry()
  const first = { id: 'pdfium.native', capabilities: [pdfCapabilities.renderPage, pdfCapabilities.renderAcroForm], implementation: {} }
  const unregisterNative = registry.register(first)
  registry.register({ id: 'other.xfa', capabilities: [pdfCapabilities.renderXfa], implementation: {}, priority: 100 })
  assert.equal((await registry.plan([pdfCapabilities.renderPage, pdfCapabilities.renderAcroForm], {}, first.id)).supported, true)
  assert.deepEqual((await registry.plan([pdfCapabilities.renderPage, pdfCapabilities.renderXfa], {}, first.id)).missing
    .map(item => item.capability), [pdfCapabilities.renderXfa])
  const priority = registry.register({ id: 'other.page', capabilities: [pdfCapabilities.renderPage], implementation: {}, priority: 2,
    supports: () => ({ available: false, reason: 'not ready' }) })
  assert.equal((await registry.resolve(pdfCapabilities.renderPage)).provider?.id, first.id)
  priority()
  unregisterNative()
  assert.equal((await registry.resolve(pdfCapabilities.renderPage)).provider, undefined)
  registry.dispose()
  assert.equal((await registry.resolve(pdfCapabilities.renderXfa)).provider, undefined)
})

test('capability registration rejects ambiguity and canceled resolution stays canceled', async () => {
  const registry = new CapabilityRegistry()
  assert.throws(() => registry.register({ id: 'bad', capabilities: ['pdf.page.render'], implementation: {} }))
  const provider = { id: 'pdfium.native', capabilities: [pdfCapabilities.renderPage], implementation: {} }
  registry.register(provider)
  assert.throws(() => registry.register(provider))
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(registry.resolve(pdfCapabilities.renderPage, { signal: abort.signal }), { name: 'AbortError' })
})

test('a failed capability probe reports its reason without hiding another provider', async () => {
  const registry = new CapabilityRegistry()
  registry.register({ id: 'broken.page', capabilities: [pdfCapabilities.renderPage], implementation: {}, priority: 2,
    supports() { throw new Error('probe failed') } })
  const fallback = registry.register({ id: 'working.page', capabilities: [pdfCapabilities.renderPage], implementation: {} })
  assert.equal((await registry.resolve(pdfCapabilities.renderPage)).provider?.id, 'working.page')
  fallback()
  assert.match((await registry.resolve(pdfCapabilities.renderPage)).reason ?? '', /broken\.page: probe failed/)
})
