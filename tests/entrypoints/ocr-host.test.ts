import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name, provide } from '../../src/entrypoints/ocr-host.ts'
import type { HostOcrService } from '../../src/modules/ocr/index.js'
import { CapabilityRegistry, pdfCapabilities } from '../../src/modules/capabilities/index.js'
import { defaultSettings } from '../../src/shared/contracts.ts'

test('OCR plugin wires its session-model backend, agent tool and Fiber disposal', async () => {
  const services = new Map<string, unknown>()
  const effects: { label: string; dispose: () => void }[] = []
  const toolNames: string[] = []
  let provided: HostOcrService | undefined
  const ctx = {
    reflect: { provide(key: string, value: HostOcrService) {
      assert.equal(key, 'ocr')
      provided = value
    } },
    effect(callback: () => () => void, label: string) {
      effects.push({ label, dispose: callback() })
    },
    tools: { register(definition: { name: string }) { toolNames.push(definition.name) } },
    get(key: string) { return services.get(key) },
    inject() { return { dispose() {} } },
  } as unknown as Context
  services.set('llm', {
    async resolveModelInfo(provider: string, model: string) {
      assert.deepEqual([provider, model], ['test-provider', 'vision-model'])
      return { inputModalities: ['text', 'image'] }
    },
    async *stream(options: { sessionId: string }) {
      assert.equal(options.sessionId, 'session-ocr-plugin')
      yield { type: 'text-delta', index: 0, text: 'Visible text' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  services.set('attachments', {
    async saveImage(input: { data: Uint8Array }) {
      assert.deepEqual([...input.data], [137, 80, 78, 71])
      return { attachmentId: 'ocr-image', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }
    },
  })

  assert.equal(name, 'image-ocr')
  assert.equal(provide, 'ocr')
  assert.deepEqual(inject, ['tools'])
  apply(ctx, Config.parse({}))
  assert.ok(provided)
  const service = provided
  try {
    assert.deepEqual(service.list().map(backend => backend.id), ['session-llm'])
    assert.deepEqual(toolNames, ['ocr_recognize'])
    assert.deepEqual(effects.map(effect => effect.label), [
      'ocr: dispose in-flight recognition', 'ocr: current-session model backend',
      'ocr: optional capability catalog',
    ])
    const missingController = await service.availability('session-ocr-plugin')
    assert.equal(missingController.status, 'unavailable')
    assert.match(missingController.reason ?? '', /session controller is unavailable/)

    services.set('sessionController', { async resolveAgent(sessionId: string) {
      assert.equal(sessionId, 'session-ocr-plugin')
      return { agent: { session: { requestHeader() {
        return { config: { provider: 'test-provider', model: 'vision-model' } }
      } } } }
    } })
    assert.equal((await service.availability('session-ocr-plugin')).status, 'available')
    const handle = await service.stageImage({
      sessionId: 'session-ocr-plugin', mediaType: 'image/png',
      image: Uint8Array.from([137, 80, 78, 71]), width: 2, height: 2, languages: ['en'],
    })
    const result = await service.recognizeStaged(handle, 'session-ocr-plugin', new AbortController().signal)
    assert.equal(result.text, 'Visible text')
    assert.deepEqual(result.source, { backendId: 'session-llm', backendVersion: '1' })
  } finally {
    for (const effect of effects.reverse()) effect.dispose()
  }
  assert.deepEqual(service.list(), [])
  assert.equal((await service.availability('session-ocr-plugin')).status, 'unavailable')
})

test('OCR service is visible only while its real Cordis Fiber is active', async () => {
  const root = new Context()
  const capabilities = new CapabilityRegistry()
  root.reflect.provide('tools', { register() { return () => undefined } })
  root.reflect.provide('pdfCapabilities', capabilities)
  try {
    const fiber = root.plugin({ name, provide, inject, Config, apply }, Config.parse({}))
    await fiber
    const service = root.get('ocr')
    assert.ok(service)
    assert.deepEqual(service.list().map(backend => backend.id), ['session-llm'])
    assert.deepEqual(capabilities.list().filter(item => item.capabilities.includes(pdfCapabilities.recognizeImage))
      .map(item => item.id), ['ocr.selected'])
    assert.match((await capabilities.resolve(pdfCapabilities.recognizeImage)).reason ?? '', /requires a session/)
    assert.match((await capabilities.resolve(pdfCapabilities.recognizeImage, { sessionId: 'session-1' })).reason ?? '',
      /Model or image attachment service is unavailable/)

    await fiber.dispose()
    assert.equal(root.get('ocr'), undefined)
    assert.deepEqual(capabilities.list(), [])
    assert.deepEqual(service.list(), [])
    assert.equal((await service.availability('session-1')).status, 'unavailable')
  } finally { await root.fiber.dispose() }
})

test('OCR capability appears when the Reader catalog loads after OCR', async () => {
  const root = new Context()
  root.reflect.provide('tools', { register() { return () => undefined } })
  const capabilities = new CapabilityRegistry()
  try {
    const fiber = root.plugin({ name, provide, inject, Config, apply }, Config.parse({}))
    await fiber
    assert.deepEqual(capabilities.list(), [])
    root.reflect.provide('pdfCapabilities', capabilities)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(capabilities.list().map(item => item.id), ['ocr.selected'])
    await fiber.dispose()
    assert.deepEqual(capabilities.list(), [])
  } finally { await root.fiber.dispose() }
})

test('generic OCR capability checks match the returned implementation and ignore another consumer PDF binding', async () => {
  const root = new Context(), capabilities = new CapabilityRegistry()
  root.reflect.provide('tools', { register() { return () => undefined } })
  root.reflect.provide('pdfCapabilities', capabilities)
  root.reflect.provide('pdfAiSettings', () => ({ ...defaultSettings, ocrEngine: 'missing.pdf.engine' }))
  try {
    const fiber = root.plugin({ name, provide, inject, Config, apply }, Config.parse({ backend: 'generic.local' }))
    await fiber
    const service = root.get('ocr')!
    service.register({ descriptor: { id: 'generic.local', name: 'Generic consumer OCR', version: '1',
      execution: 'local', geometry: [], confidence: false },
      async availability() { return { status: 'available' } }, async recognize() {
        return { text: 'Generic fixture', blocks: [], lines: [], words: [], coverage: [], warnings: [], confidence: null, status: 'complete' }
      } })
    const resolved = await capabilities.resolve(pdfCapabilities.recognizeImage, { sessionId: 'fixture-session' })
    assert.equal(resolved.provider?.implementation, service)
    assert.equal((await service.recognize({ sessionId: 'fixture-session', image: new Uint8Array([1]),
      mediaType: 'image/png', width: 1, height: 1, languages: ['auto'] })).text, 'Generic fixture')
    assert.equal((await service.availability('fixture-session', new AbortController().signal,
      { engineId: 'missing.pdf.engine' })).status, 'unavailable')
    await fiber.dispose()
  } finally { await root.fiber.dispose(); capabilities.dispose() }
})
