import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranslationContent } from '../../../src/modules/viewer/components/TranslationPanel.js'
import { translationEn, translationZh } from '../../../src/translation/index.js'

const translate = (dictionary: typeof translationEn) => (key: string) =>
  dictionary[key.replace(/^reader\./, '') as keyof typeof translationEn] ?? key

test('word detail displays pronunciation, each meaning, and example translations', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    t: translate(translationZh),
    value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: 'SERIALIZED_TEXT_SHOULD_NOT_BE_REPEATED',
      status: 'complete',
      warnings: [],
      detail: {
        kind: 'word',
        pronunciation: '/ˈentər/',
        meanings: [
          { partOfSpeech: '动词', meaning: '进入', example: 'Please enter the room.', exampleTranslation: '请进入房间。' },
          { partOfSpeech: '及物动词', meaning: '输入', example: 'Enter your name.', exampleTranslation: '输入你的名字。' },
        ],
      },
    },
  }))

  assert.match(html, /data-translation-kind="word"/)
  assert.doesNotMatch(html, /dsh-pdf-translation-term/)
  assert.match(html, /音标/)
  assert.match(html, /ˈentər/)
  assert.match(html, /进入/)
  assert.match(html, /输入/)
  assert.match(html, /动词/)
  assert.match(html, /及物动词/)
  assert.match(html, /Please enter the room\./)
  assert.match(html, /请进入房间。/)
  assert.match(html, /Enter your name\./)
  assert.match(html, /输入你的名字。/)
  assert.equal((html.match(/class="dsh-pdf-translation-meaning"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /SERIALIZED_TEXT_SHOULD_NOT_BE_REPEATED/)
})

test('word detail renders all 25 meanings, including the final example, without truncation', () => {
  const meanings = Array.from({ length: 25 }, (_, index) => ({
    partOfSpeech: index % 2 ? '名词' : '动词',
    meaning: `含义 ${index + 1}`,
    example: `Use on in example ${index + 1}.`,
    exampleTranslation: `例句 ${index + 1}。`,
  }))
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    t: translate(translationZh),
    value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: 'SERIALIZED_TEXT_SHOULD_NOT_BE_REPEATED',
      status: 'complete', warnings: [],
      detail: { kind: 'word', pronunciation: '/ɒn/', meanings },
    },
  }))

  assert.equal((html.match(/class="dsh-pdf-translation-meaning"/g) ?? []).length, 25)
  assert.match(html, /含义 25/)
  assert.match(html, /Use on in example 25\./)
  assert.match(html, /例句 25。/)
  assert.equal((html.match(/(?:动词|名词)/g) ?? []).length, 25)
  assert.doesNotMatch(html, /SERIALIZED_TEXT_SHOULD_NOT_BE_REPEATED/)
})

test('phrase presentation displays model-supplied pronunciation as well as meanings', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    t: translate(translationEn),
    value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: 'take off: leave the ground',
      status: 'complete',
      warnings: [],
      detail: {
        kind: 'phrase',
        pronunciation: '/teɪk ɒf/',
        meanings: [
          { partOfSpeech: 'phrasal verb', meaning: 'leave the ground', example: 'The plane took off.', exampleTranslation: '飞机起飞了。' },
        ],
      },
    },
  }))

  assert.match(html, /data-translation-kind="phrase"/)
  assert.doesNotMatch(html, /dsh-pdf-translation-term|take off: leave the ground/)
  assert.match(html, /Phrase/)
  assert.match(html, /phrasal verb/)
  assert.match(html, /The plane took off\./)
  assert.match(html, /dsh-pdf-translation-pronunciation/)
  assert.match(html, /teɪk ɒf/)
})

test('sentence translation keeps the plain-text result', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    t: translate(translationZh),
    value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: '请进入房间。',
      status: 'complete',
      warnings: [],
    },
  }))

  assert.match(html, /class="dsh-pdf-translation-text"/)
  assert.match(html, /请进入房间。/)
  assert.doesNotMatch(html, /dsh-pdf-translation-details/)
})

test('presentation of supplied lexical data identifies the interpretation and escapes its explanation', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    t: translate(translationZh), value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: '相减', status: 'complete', warnings: [],
      interpretation: { text: 'subtract', kind: 'completion', certainty: 'tentative',
        explanation: '<img src=x onerror=alert(1)> 可能是缺少词尾。' },
      detail: { kind: 'word', meanings: [{ partOfSpeech: '动词', meaning: '减去',
        example: 'Subtract two from five.', exampleTranslation: '五减二。' }] },
    },
  }))
  assert.match(html, /role="note"/)
  assert.match(html, /data-certainty="tentative"/)
  assert.match(html, /推测补全/)
  assert.match(html, /class="dsh-pdf-translation-interpreted-text" dir="auto">subtract</)
  assert.equal((html.match(/>subtract</g) ?? []).length, 1, 'the completed text belongs only to its qualified notice')
  assert.doesNotMatch(html, /dsh-pdf-translation-term/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<img\b|>subtrac</)
})

test('readable sentence fragments render a direct translation without a repair notice', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    t: translate(translationZh), value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: '我们希望计算', status: 'complete', warnings: [],
    },
  }))
  assert.match(html, /我们希望计算/)
  assert.doesNotMatch(html, /role="note"|dsh-pdf-translation-interpretation|推测|纠正|补全/)
})

test('confident correction and completion have distinct localized labels', () => {
  for (const [kind, expected] of [['correction', 'Corrected text'], ['completion', 'Completed text']] as const) {
    const html = renderToStaticMarkup(React.createElement(TranslationContent, {
      t: translate(translationEn), value: {
        source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
        text: 'Result', status: 'complete', warnings: [], interpretation: { kind, certainty: 'confident',
          text: 'reconstructed source', explanation: 'Recovered using the nearby words.' },
      },
    }))
    assert.match(html, new RegExp(expected))
    assert.match(html, /reconstructed source/)
    assert.doesNotMatch(html, /Possible correction|Possible completion/)
  }
})
