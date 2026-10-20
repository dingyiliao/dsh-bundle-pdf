import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranslationErrorNotice } from '../../../src/modules/viewer/components/TranslationPanel.js'
import { translationEn, translationZh } from '../../../src/translation/index.js'
import { TranslationError, type TranslationErrorCode } from '../../../src/translation/types.js'

function renderError(code: TranslationErrorCode, dictionary: Record<string, string>) {
  const t = (key: string) => dictionary[key.replace(/^reader\./, '')] ?? key
  return renderToStaticMarkup(React.createElement(TranslationErrorNotice, { code, t }))
}

test('an invalid word explanation shows a localized reason without duplicating Retry', () => {
  const english = renderError('invalid-model-output', translationEn)
  const chinese = renderError('invalid-model-output', translationZh)

  assert.match(english, /role="alert"/)
  assert.ok(english.includes(translationEn['translation.errorTitle']))
  assert.ok(english.includes(translationEn['translation.errorInvalidModelOutput']))
  assert.match(english, /model/i)
  assert.match(english, /meaning|example|format|response/i)
  assert.doesNotMatch(english, /<button\b|reader\.translation\.|translation\.error/)

  assert.ok(chinese.includes(translationZh['translation.errorTitle']))
  assert.ok(chinese.includes(translationZh['translation.errorInvalidModelOutput']))
  assert.match(chinese, /模型/)
  assert.match(chinese, /格式|返回/)
  assert.doesNotMatch(chinese, /<button\b|reader\.translation\.|translation\.error/)
})

test('incomplete and empty model output have distinct actionable notices', () => {
  const incomplete = renderError('incomplete-model-output', translationEn)
  const empty = renderError('empty-model-output', translationEn)

  assert.notEqual(incomplete, empty)
  assert.ok(incomplete.includes(translationEn['translation.errorIncompleteModelOutput']))
  assert.ok(empty.includes(translationEn['translation.errorEmptyModelOutput']))
  assert.match(incomplete, /incomplete|truncat|cut short|output limit|before .* complete/i)
  assert.match(empty, /empty|no text|without text|did not return text|no translation/i)
  assert.doesNotMatch(incomplete + empty, /reader\.translation\.|translation\.error/)
})

test('the notice selects safe copy by error code, not a raw provider message', () => {
  const error = new TranslationError('translation-failed',
    'Provider raw error: token sk-secret-123, internal route /private/model')
  const html = renderError(error.code, translationEn)

  assert.ok(html.includes(translationEn['translation.errorTitle']))
  assert.ok(html.includes(translationEn['translation.errorFailed']))
  assert.doesNotMatch(html, /sk-secret-123|\/private\/model|Provider raw error/)
  assert.doesNotMatch(html, /<button\b/)
})
