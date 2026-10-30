import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TranslationPanel } from '../../../src/modules/viewer/components/TranslationPanel.js'
import { readerLocales } from '../../../src/modules/viewer/locales.js'
import { TranslationRegistry } from '../../../src/translation/registry.js'
import { createDshModelTranslationEngine } from '../../../src/adapters/host/dsh/translation-model.js'

interface ControlledCase {
  text: string
  /** Raw provider JSON: this fixture never supplies a finished TranslationResult. */
  response: string
  before?: string
  after?: string
}
interface CapturedInput {
  text: string
  target_language: string
  source_language: string
  nearby_text?: { before: string; after: string }
}
const requests: CapturedInput[] = []
let providerResponse = ''
const registry = new TranslationRegistry({ timeoutMs: 5000, maxInputCharacters: 10000, maxOutputCharacters: 32768 })
registry.register(createDshModelTranslationEngine({
  llm: { async *stream(options) {
    requests.push(JSON.parse(options.messages[0]!.content[0]!.text) as CapturedInput)
    const response = providerResponse, middle = Math.floor(response.length / 2)
    yield { type: 'text-delta', index: 0, text: response.slice(0, middle) }
    yield { type: 'text-delta', index: 0, text: response.slice(middle) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } },
  resolveContext: () => ({ provider: 'controlled-provider', model: 'controlled-model' }),
  maxOutputTokens: 4096,
}))
registry.select({ engineId: 'dsh-model', id: 'controlled-instance', configurationRevision: '1', config: {} })

function Fixture() {
  const [prepared, setPrepared] = useState<ControlledCase>()
  const [active, setActive] = useState<ControlledCase>()
  Object.assign(window, { __pdfTranslationRecoveryFixture: {
    prepare(value: ControlledCase) { setActive(undefined); setPrepared(value) },
    requests: () => structuredClone(requests),
  } })
  if (!active) return <button type="button" disabled={!prepared} onClick={() => {
    providerResponse = prepared!.response
    setActive(prepared)
  }}>Translate selection</button>
  return <TranslationPanel selection={{ text: active.text, pages: [86], targetLanguage: 'zh' }} engineName="DSH Model"
    translate={request => registry.translate({ ...request, context: { sessionId: 'controlled-session',
      selectionBefore: active.before, selectionAfter: active.after } })}
    rememberTargetLanguage={async () => true} onClose={() => setActive(undefined)}
    t={key => readerLocales.zh[key] ?? key} />
}

createRoot(document.getElementById('translation-root')!).render(<Fixture />)
