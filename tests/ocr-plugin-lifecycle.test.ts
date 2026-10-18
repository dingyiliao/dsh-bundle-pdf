import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name, provide } from '../src/host/ocr-plugin.ts'
import type { HostOcrService } from '../src/host/ocr-service.ts'

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
