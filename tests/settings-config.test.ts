import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateEngineConfigurations, migrateImageEngine } from '../src/shared/engine-configuration-migration.js'
import { Config, readConfig, type HostConfig } from '../src/entrypoints/reader-host-config.ts'
import { createHostTranslations, type TranslationHostContext } from '../src/adapters/host/dsh/translations.ts'
import { defaultSettings, translationTargetLanguages } from '../src/shared/contracts.ts'
import { TranslationError } from '../src/translation/index.ts'
import type { EngineConfiguration } from '../src/modules/engines/index.ts'
import z from '@deepseek-ai/schemastery'

const validate = Config as unknown as (value: Record<string, unknown>) => Record<string, { get(): unknown }>

test('retrieval preprocessing settings default OCR on and descriptions off and retain boolean values through schema transport', () => {
  const defaults = readConfig(validate({}) as unknown as HostConfig)
  assert.equal(defaults.indexScanPages, true)
  assert.equal(defaults.indexImageDescriptions, false)
  assert.equal(defaults.embeddingEngine, 'none', 'preprocessing options do not enable semantic search')
  assert.equal(defaults.ocrEngine, 'session-llm')
  assert.equal(defaults.imageEngine, 'dsh-vision')
  assert.equal('indexDescriptionEngine' in defaults, false)
  const settings = readConfig(validate({ indexScanPages: false, indexImageDescriptions: true }) as unknown as HostConfig)
  assert.equal(settings.indexScanPages, false)
  assert.equal(settings.indexImageDescriptions, true)
  const clientSchema = new z(JSON.parse(JSON.stringify(Config.toJSON())))
  assert.equal(clientSchema(settings).indexScanPages.get(), false)
  assert.equal(clientSchema(settings).indexImageDescriptions.get(), true)
  for (const field of ['indexScanPages', 'indexImageDescriptions']) {
    assert.throws(() => validate({ [field]: 'false' }))
    assert.throws(() => validate({ [field]: 'true' }))
  }
})

test('visual indexing uses the shared image engine and drops the retired independent selection', () => {
  const settings = readConfig(validate({ ocrEngine: 'fixture.ocr', imageEngine: 'fixture.vision',
    indexDescriptionEngine: 'retired.vision', indexScanPages: true, indexImageDescriptions: true,
    engineConfigurations: { image: { 'fixture.vision': { model: 'visual-model' } },
      ocr: { 'fixture.ocr': { language: 'eng' } } },
  }) as unknown as HostConfig)
  assert.equal(settings.ocrEngine, 'fixture.ocr')
  assert.equal(settings.imageEngine, 'fixture.vision')
  assert.equal('indexDescriptionEngine' in settings, false)
  assert.equal(settings.indexScanPages, true)
  assert.equal(settings.indexImageDescriptions, true)
  assert.deepEqual(settings.engineConfigurations?.image?.['fixture.vision'], { model: 'visual-model' })
  assert.equal('indexDescriptionEngine' in validate({}), false)
  const clientSchema = new z(JSON.parse(JSON.stringify(Config.toJSON())))
  assert.equal(clientSchema(settings).imageEngine.get(), 'fixture.vision')
})

test('retired session and auxiliary image choices migrate to one DSH vision adapter without changing model routes', () => {
  const saved = { image: { 'session-vision': {}, 'auxiliary-vision': { provider: 'custom', model: 'vision-small' },
    'third.party': { endpoint: 'https://vision.example' } } }
  const auxiliary = readConfig(validate({ imageEngine: 'auxiliary-vision', engineConfigurations: saved }) as unknown as HostConfig)
  assert.equal(auxiliary.imageEngine, 'dsh-vision')
  assert.deepEqual(auxiliary.engineConfigurations?.image, {
    'dsh-vision': { provider: 'custom', model: 'vision-small' }, 'third.party': saved.image['third.party'],
  })
  const session = readConfig(validate({ imageEngine: 'session-vision', engineConfigurations: saved }) as unknown as HostConfig)
  assert.equal(session.imageEngine, 'dsh-vision')
  assert.deepEqual(session.engineConfigurations?.image?.['dsh-vision'], {})
  assert.deepEqual(saved.image['auxiliary-vision'], { provider: 'custom', model: 'vision-small' }, 'migration does not mutate saved data')
  const edited = { image: { 'dsh-vision': { provider: 'custom', model: 'edited-model' } } }
  assert.deepEqual(migrateEngineConfigurations(edited, 'auxiliary-vision'), edited,
    'saving a normalized configuration survives an unchanged legacy selector in the profile')
  const ocrOnly = readConfig(validate({ imageEngine: 'ocr-text', indexImageDescriptions: true }) as unknown as HostConfig)
  assert.equal(ocrOnly.imageEngine, 'ocr-text', 'an old OCR bridge must not silently opt into remote vision')
  assert.equal(migrateImageEngine('third.party'), 'third.party')
  assert.equal(migrateImageEngine('dsh-vision'), 'dsh-vision')
})

test('legacy auxiliary routes that depend on removed Host-only settings stay unavailable until explicitly selected', () => {
  const routes: EngineConfiguration[] = [{}, { provider: 'custom' }, { model: 'vision-small' }, { provider: 'custom', model: '  ' }]
  for (const route of routes) {
    const engineConfigurations = { image: { 'auxiliary-vision': route } }
    const configured = validate({ imageEngine: 'auxiliary-vision', engineConfigurations })
    const settings = readConfig(configured as unknown as HostConfig)
    assert.equal(settings.imageEngine, 'auxiliary-vision', 'unknown old routing must not silently follow the session model')
    assert.deepEqual(settings.engineConfigurations, engineConfigurations)
    assert.equal(Object.hasOwn(settings.engineConfigurations?.image ?? {}, 'dsh-vision'), false)
    assert.strictEqual(migrateEngineConfigurations(engineConfigurations, 'auxiliary-vision'), engineConfigurations)
  }
})

test('explicit new vision model configuration takes priority over a retired auxiliary route', () => {
  const oldRoute = { provider: 'old-provider', model: 'old-model' }
  const newRoute = { provider: 'new-provider', model: 'new-model', reasoningEffort: 'low' }
  const routes: EngineConfiguration[] = [{}, { provider: 'partial' }, oldRoute]
  for (const legacyRoute of routes) {
    const configurations = { image: { 'auxiliary-vision': legacyRoute, 'dsh-vision': newRoute } }
    const settings = readConfig(validate({ imageEngine: 'auxiliary-vision', engineConfigurations: configurations }) as unknown as HostConfig)
    assert.equal(settings.imageEngine, 'dsh-vision')
    assert.deepEqual(settings.engineConfigurations?.image, { 'dsh-vision': newRoute })
    assert.deepEqual(configurations.image['auxiliary-vision'], legacyRoute)
  }
})

test('Host settings discard only removed form-engine configuration and preserve active engine values', () => {
  const active = {
    ocr: { 'fixture.ocr': { language: 'auto', enabled: true } },
    image: { 'fixture.vision': { model: 'fixture-model' } },
    translation: { 'fixture.translation': { timeout: 30000 } },
  }
  const saved = { ...active, form: { 'fixture.forms': { model: 'retired-model' } } }
  const configured = validate({ engineConfigurations: saved })
  assert.deepEqual(readConfig(configured as unknown as HostConfig).engineConfigurations, active)
  assert.deepEqual(configured.engineConfigurations.get(), saved, 'reading does not mutate the stored configuration')
  assert.throws(() => readConfig(validate({ engineConfigurations: {
    ...saved, unknown: { 'fixture.engine': {} },
  } }) as unknown as HostConfig), /Unrecognized key/)
  assert.throws(() => readConfig(validate({ engineConfigurations: {
    ...saved, ocr: { 'fixture.ocr': { language: 'x'.repeat(8193) } },
  } }) as unknown as HostConfig), /8192/)
})

test('retired built-in embedding revisions are removed without changing provider settings or saved values', () => {
  const saved = { embedding: {
    'local-qwen3-embedding': { endpoint: 'https://embedding.example/v1/embeddings', model: 'embedding', modelRevision: 'old-user-tag' },
    'custom-provider': { modelRevision: 'provider-owned-value', dimensions: 2 },
  }, ocr: { fixture: { language: 'auto' } } }
  const configured = validate({ engineConfigurations: saved })
  const settings = readConfig(configured as unknown as HostConfig)
  assert.deepEqual(settings.engineConfigurations?.embedding?.['local-qwen3-embedding'], {
    endpoint: 'https://embedding.example/v1/embeddings', model: 'embedding',
  })
  assert.deepEqual(settings.engineConfigurations?.embedding?.['custom-provider'], saved.embedding['custom-provider'])
  assert.deepEqual(configured.engineConfigurations.get(), saved)
  assert.deepEqual(migrateEngineConfigurations(), {})
  assert.strictEqual(migrateEngineConfigurations(settings.engineConfigurations), settings.engineConfigurations)
})

test('PDF settings expose only the supported translation targets and no source/default-color fields', () => {
  const defaults = validate({})
  assert.equal(defaults.translationEngine.get(), 'dsh-model')
  assert.equal(defaults.translationTargetLanguage.get(), 'zh')
  assert.equal(defaults.maxFileBytes.get(), defaultSettings.maxFileBytes)
  assert.equal(defaults.explanationPromptTemplate.get(), defaultSettings.explanationPromptTemplate)
  assert.equal(defaults.explanationGeneralInstruction.get(), '')
  assert.equal(defaults.explanationTextInstruction.get(), '')
  assert.equal(defaults.explanationImageInstruction.get(), '')
  assert.equal('translationSourceLanguage' in defaults, false)
  assert.equal('defaultColor' in defaults, false)
  const legacy = validate({ translationSourceLanguage: 'en', defaultColor: '#123456' })
  const runtime = readConfig(legacy as unknown as HostConfig)
  assert.equal('translationSourceLanguage' in runtime, false)
  assert.equal('defaultColor' in runtime, false)
  for (const target of translationTargetLanguages) {
    assert.equal(validate({ translationTargetLanguage: target }).translationTargetLanguage.get(), target)
  }
  assert.throws(() => validate({ translationTargetLanguage: 'not-a-language' }))
})

test('explanation prompt templates are profile-configurable and reject broken item slots', () => {
  const template = 'Explain {{count}} items from {{document}}:\n{{items}}'
  const configured = validate({ explanationPromptTemplate: template })
  assert.equal(readConfig(configured as unknown as HostConfig).explanationPromptTemplate, template)
  for (const bad of ['', 'No item slot', '{{items}} and {{items}}', '{{unknown}} {{items}}']) {
    assert.throws(() => validate({ explanationPromptTemplate: bad }))
  }
  // The settings Client validates a JSON-rehydrated Host schema, not the live
  // schema object. It must accept the current value or the card stays loading.
  const transmitted = JSON.parse(JSON.stringify(Config.toJSON()))
  const clientSchema = new z(transmitted)
  assert.equal(clientSchema(readConfig(configured as unknown as HostConfig)).explanationPromptTemplate.get(), template)
  assert.equal(clientSchema(defaultSettings).explanationPromptTemplate.get(), defaultSettings.explanationPromptTemplate)
  assert.throws(() => clientSchema({ ...defaultSettings, explanationPromptTemplate: '{{items}} {{items}}' }))
})

test('separate explanation instructions are optional, bounded and survive Host-to-Client schema transport', () => {
  const configured = validate({ explanationGeneralInstruction: 'Explain carefully',
    explanationTextInstruction: 'Check assumptions', explanationImageInstruction: 'Read the axes' })
  const settings = readConfig(configured as unknown as HostConfig)
  assert.deepEqual([settings.explanationGeneralInstruction, settings.explanationTextInstruction,
    settings.explanationImageInstruction], ['Explain carefully', 'Check assumptions', 'Read the axes'])
  const clientSchema = new z(JSON.parse(JSON.stringify(Config.toJSON())))
  assert.equal(clientSchema(settings).explanationImageInstruction.get(), 'Read the axes')
  assert.throws(() => validate({ explanationTextInstruction: 'x'.repeat(2001) }))
})

test('the Host config keeps the PDF size limit configurable for bundle patches', () => {
  const patchedLimit = 32 * 1024 * 1024
  const patched = validate({ maxFileBytes: patchedLimit })
  assert.equal(patched.maxFileBytes.get(), patchedLimit)
  assert.equal(readConfig(patched as unknown as HostConfig).maxFileBytes, patchedLimit)
  assert.throws(() => validate({ maxFileBytes: 0 }))
})

test('an older disabled translation setting resumes with the DSH model', () => {
  const legacy = validate({ translationEngine: 'none' })
  assert.equal(readConfig(legacy as unknown as HostConfig).translationEngine, 'dsh-model')
})

test('the Host translation route enforces automatic source detection and supported target languages', async () => {
  const translations = createHostTranslations({
    get: () => undefined,
    sessionController: { async resolveAgent() { return { error: new Error('not used') } } },
  }, 'test', () => defaultSettings)
  try {
    await assert.rejects(translations.dispatch('session', {
      sessionId: 'session', engineId: 'dsh-model', text: 'Hello', sourceLanguage: 'en',
      targetLanguage: 'zh', timeoutMs: 30000,
    }, { session: { id: 'session', header: {} } }, new AbortController().signal),
    error => error instanceof TranslationError && error.code === 'invalid-request')
    await assert.rejects(translations.dispatch('session', {
      sessionId: 'session', engineId: 'dsh-model', text: 'Hello', sourceLanguage: 'auto',
      targetLanguage: 'not-a-language', timeoutMs: 30000,
    }, { session: { id: 'session', header: {} } }, new AbortController().signal),
    error => error instanceof TranslationError && error.code === 'invalid-request')
  } finally {
    translations.registry.dispose()
  }
})

test('saving a new target preference does not invalidate an in-flight translation', async () => {
  let settings = { ...defaultSettings }
  const context = {
    get(key: string) {
      if (key !== 'llm') return undefined
      return { async *stream() {
        yield { type: 'text-delta', index: 0, text: '{"kind":"sentence","translation":"译文。"}' }
        settings = { ...settings, translationTargetLanguage: 'fr' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    },
    sessionController: { async resolveAgent() { return { agent: { session: {
      requestHeader: () => ({ config: { provider: 'test', model: 'test' } }),
    } } } } },
  } as unknown as TranslationHostContext
  const translations = createHostTranslations(context, 'test', () => settings)
  try {
    const result = await translations.dispatch('session', {
      sessionId: 'session', engineId: 'dsh-model', text: 'A complete sentence.', sourceLanguage: 'auto',
      targetLanguage: 'zh', timeoutMs: 30000,
    }, { session: { id: 'session', header: {} } }, new AbortController().signal)
    assert.equal((result as { text: string }).text, '译文。')
    assert.equal(settings.translationTargetLanguage, 'fr')
  } finally {
    translations.registry.dispose()
  }
})
