import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranslationContent } from '../src/client/TranslationPanel.js'
import { translationEn, translationZh } from '../src/client/translation-locales.js'

const translate = (dictionary: typeof translationEn) => (key: string) =>
  dictionary[key.replace(/^reader\./, '') as keyof typeof translationEn] ?? key

test('word detail displays pronunciation, each meaning, and example translations', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    sourceText: 'enter',
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
  assert.match(html, /enter/)
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
    sourceText: 'on',
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

test('phrase detail shows multiple meanings without a pronunciation row', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    sourceText: 'take off',
    t: translate(translationEn),
    value: {
      source: { engineId: 'dsh-model', engineVersion: '1', instanceId: 'test', configurationRevision: 'test' },
      text: 'take off: leave the ground',
      status: 'complete',
      warnings: [],
      detail: {
        kind: 'phrase',
        meanings: [
          { partOfSpeech: 'phrasal verb', meaning: 'leave the ground', example: 'The plane took off.', exampleTranslation: '飞机起飞了。' },
        ],
      },
    },
  }))

  assert.match(html, /data-translation-kind="phrase"/)
  assert.match(html, /take off/)
  assert.match(html, /Phrase/)
  assert.match(html, /phrasal verb/)
  assert.match(html, /The plane took off\./)
  assert.doesNotMatch(html, /dsh-pdf-translation-pronunciation/)
})

test('sentence translation keeps the plain-text result', () => {
  const html = renderToStaticMarkup(React.createElement(TranslationContent, {
    sourceText: 'Please enter the room.',
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
