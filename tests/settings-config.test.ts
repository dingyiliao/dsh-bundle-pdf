import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, readConfig, type HostConfig } from '../src/entrypoints/reader-host-config.ts'
import { createHostTranslations, type TranslationHostContext } from '../src/adapters/host/dsh/translations.ts'
import { defaultSettings, translationTargetLanguages } from '../src/shared/contracts.ts'
import { TranslationError } from '../src/translation/index.ts'
import z from '@deepseek-ai/schemastery'

const validate = Config as unknown as (value: Record<string, unknown>) => Record<string, { get(): unknown }>

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
        yield { type: 'text-delta', index: 0, text: '{"recognized":true,"translation":"译文。"}' }
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
