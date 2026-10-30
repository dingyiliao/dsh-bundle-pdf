import assert from 'node:assert/strict'
import test from 'node:test'
import { createPdfEngineRouting } from '../../../src/adapters/host/dsh/engine-routing.ts'
import { createHostTranslations } from '../../../src/adapters/host/dsh/translations.ts'
import { HostOcrService } from '../../../src/modules/ocr/index.ts'
import { HostImageUnderstandingService } from '../../../src/modules/image-understanding/index.ts'
import { defaultSettings, type PdfSettings } from '../../../src/shared/contracts.ts'

test('PDF OCR and image availability use their independent consumer bindings without changing generic defaults', async () => {
  const ocr = new HostOcrService(() => 'missing-default')
  const image = new HostImageUnderstandingService(() => 'missing-default')
  let settings: PdfSettings = { ...defaultSettings, ocrEngine: 'fixture.ocr', imageEngine: 'fixture.image',
    engineConfigurations: { ocr: { 'fixture.ocr': { language: 'eng' } }, image: { 'fixture.image': { style: 'short' } } } }
  const seen: unknown[] = []
  ocr.register({ descriptor: { id: 'fixture.ocr', name: 'Fixture OCR', version: '1', execution: 'local', geometry: [], confidence: false,
    configurationFields: [{ key: 'language', label: 'Language', type: 'string' }] },
    async availability() { return { status: 'available' } }, async recognize(_request, config) {
      seen.push(config)
      return { text: 'Fixture OCR text', status: 'complete', blocks: [], lines: [], words: [], warnings: [], coverage: [], confidence: null }
    } })
  image.register({ descriptor: { id: 'fixture.image', name: 'Fixture image', version: '1', execution: 'local',
      configurationFields: [{ key: 'style', label: 'Style', type: 'string' }] },
    async availability(_session, _signal, config) { seen.push({ config }); return { available: true } },
    async understand() { throw new Error('Status routing must not execute image understanding') } })
  const routing = createPdfEngineRouting({ get(key: string) {
    return key === 'ocr' ? ocr : key === 'imageUnderstanding' ? image : key === 'pdfAiSettings' ? () => settings : undefined
  } } as never)
  const signal = new AbortController().signal
  try {
    assert.equal((await ocr.availability('fixture-session', signal)).status, 'unavailable')
    const bound = routing.ocr()!
    assert.equal((await bound.availability('fixture-session', signal)).status, 'available')
    const handle = await bound.stageImage({ sessionId: 'fixture-session', image: new Uint8Array([1]),
      mediaType: 'image/png', width: 1, height: 1, languages: ['eng'] })
    settings = { ...settings, ocrEngine: 'not-installed' }
    await ocr.recognizeStaged(handle, 'fixture-session', signal)
    assert.deepEqual(seen[0], { language: 'eng' }, 'staged images capture their consumer binding')
    assert.equal((await routing.ocr()!.availability('fixture-session', signal)).status, 'unavailable')
    settings = { ...settings, ocrEngine: 'fixture.ocr' }
    assert.equal((await image.availability('fixture-session', signal)).status, 'unavailable')
    assert.deepEqual(await routing.image()!.availability('fixture-session', signal),
      { status: 'available', backendId: 'fixture.image' })
    assert.deepEqual(seen.at(-1), { config: { style: 'short' } }, 'vision status never receives an OCR binding')
    assert.equal('prepare' in routing.image()!, false, 'status-only routing exposes no unused image execution API')
    settings = { ...settings, imageEngine: 'missing-image' }
    assert.equal((await routing.image()!.availability('fixture-session', signal)).status, 'unavailable')
    assert.deepEqual(image.selectedDescriptor(), undefined, 'consumer routing never changes the generic service default')
  } finally { ocr.dispose(); image.dispose() }
})

test('Host translation executes only the selected registered implementation and validates its configuration', async () => {
  let settings: PdfSettings = { ...defaultSettings, translationEngine: 'fixture.translation',
    engineConfigurations: { translation: { 'fixture.translation': { style: 'short' } } } }
  const host = createHostTranslations({ get: () => undefined,
    sessionController: { async resolveAgent() { throw new Error('Default model must not be consulted') } },
  }, 'fixture', () => settings)
  const seen: unknown[] = []
  const remove = host.registry.register({ descriptor: { id: 'fixture.translation', name: 'Fixture translator', version: '1', execution: 'local',
    configurationFields: [{ key: 'style', label: 'Style', type: 'string', required: true }] }, async translate(_request, config) {
      seen.push(config); return { text: 'Fixture translation', status: 'complete', warnings: [] }
    } })
  const agent = { session: { id: 'fixture-session', header: {} } }, signal = new AbortController().signal
  const args = { sessionId: 'fixture-session', engineId: 'fixture.translation', text: 'Fixture sentence.',
    sourceLanguage: 'auto', targetLanguage: 'zh', timeoutMs: 1000 }
  try {
    const result = await host.dispatch('fixture-session', args, agent, signal) as { text: string; source: { configurationRevision: string } }
    assert.equal(result.text, 'Fixture translation')
    assert.deepEqual(seen, [{ style: 'short' }])
    assert.match(result.source.configurationRevision, /^[a-f0-9]{64}$/)
    assert.equal(host.registry.getSelection(), undefined, 'Host routing does not mutate a shared selected instance')
    await assert.rejects(host.dispatch('fixture-session', { ...args, engineId: 'dsh-model' }, agent, signal), { code: 'stale-result' })
    settings = { ...settings, engineConfigurations: {} }
    await assert.rejects(host.dispatch('fixture-session', args, agent, signal), { code: 'not-configured' })
    remove()
    await assert.rejects(host.dispatch('fixture-session', args, agent, signal), { code: 'engine-unavailable' })
    assert.equal(seen.length, 1)
  } finally { host.registry.dispose() }
})
