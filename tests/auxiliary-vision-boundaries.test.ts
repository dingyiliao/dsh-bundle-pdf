import assert from 'node:assert/strict'
import test from 'node:test'
import { createAuxiliaryVisionBackend, type AuxiliaryVisionDependencies } from '../src/host/image-understanding-auxiliary.ts'
import { ImageUnderstandingError, MAX_DERIVED_TEXT_CHARACTERS,
  type ImageUnderstandingRequest } from '../src/host/image-understanding-service.ts'

const request = (signal = new AbortController().signal): ImageUnderstandingRequest => ({
  sessionId: 'session', question: 'What does the figure show?', signal,
  image: { mediaType: 'image/png', data: new Uint8Array([1, 2]), width: 1, height: 1 },
})
const reference = { attachmentId: 'image', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }
const hasCode = (code: string) => (error: unknown) => error instanceof ImageUnderstandingError && error.code === code
const dependencies = (overrides: Partial<AuxiliaryVisionDependencies> = {}): AuxiliaryVisionDependencies => ({
  selectedModel: () => ({ provider: 'vision', model: 'illustrations' }),
  getAttachments: () => ({ async saveImage() { return reference } }),
  getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } },
    async *stream() { yield { type: 'text-delta', index: 0, text: 'A diagram.' }
      yield { type: 'finish', reason: { kind: 'stop' } } },
  }),
  ...overrides,
})

test('auxiliary vision refuses oversized identifiers, unavailable services and model lookup failures', async () => {
  const signal = request().signal
  const oversized = createAuxiliaryVisionBackend(dependencies({
    selectedModel: () => ({ provider: 'vision', model: 'x'.repeat(255) }),
  }))
  assert.deepEqual(await oversized.availability('session', signal), {
    available: false, reason: 'The auxiliary vision model identifier is too long.',
  })
  await assert.rejects(oversized.prepare(request()), hasCode('pdf/image-unconfigured'))

  const missingServices = createAuxiliaryVisionBackend(dependencies({ getAttachments: () => undefined }))
  await assert.rejects(missingServices.prepare(request()), hasCode('pdf/image-unavailable'))
  const modelFailure = createAuxiliaryVisionBackend(dependencies({ getLlm: () => ({
    async resolveModelInfo() { throw new Error('provider offline') },
    async *stream() { throw new Error('must not start'); yield { type: 'finish' } },
  }) }))
  assert.deepEqual(await modelFailure.availability('session', signal), {
    available: false, reason: 'The configured auxiliary model cannot be resolved.',
  })
  await assert.rejects(modelFailure.prepare(request()), hasCode('pdf/image-unavailable'))
})

test('auxiliary vision does not start inference if durable image storage fails', async () => {
  let started = 0
  const backend = createAuxiliaryVisionBackend(dependencies({
    getAttachments: () => ({ async saveImage() { throw new Error('storage unavailable') } }),
    getLlm: () => ({ async resolveModelInfo() { return { inputModalities: ['image'] } },
      async *stream() { started++; yield { type: 'finish' } } }),
  }))
  await assert.rejects(backend.prepare(request()), hasCode('pdf/image-unavailable'))
  assert.equal(started, 0)
})

test('auxiliary vision reports a stream that cannot start rather than returning empty evidence', async () => {
  const backend = createAuxiliaryVisionBackend(dependencies({ getLlm: () => ({
    async resolveModelInfo() { return { inputModalities: ['image'] } },
    stream() { throw new Error('stream failed synchronously') },
  } as never) }))
  await assert.rejects(backend.prepare(request()), hasCode('pdf/image-unavailable'))
})

test('auxiliary vision rejects tool requests, invalid block indexes, excess blocks and excess output', async () => {
  const testStream = async (chunks: unknown[], code: string) => {
    const backend = createAuxiliaryVisionBackend(dependencies({ getLlm: () => ({
      async resolveModelInfo() { return { inputModalities: ['image'] } },
      async *stream() { for (const chunk of chunks) yield chunk as never },
    }) }))
    await assert.rejects(backend.prepare(request()), hasCode(code))
  }
  await testStream([{ type: 'tool-call-delta' }], 'pdf/image-invalid-result')
  await testStream([{ type: 'text-delta', index: -1, text: 'invalid' }], 'pdf/image-invalid-result')
  await testStream(Array.from({ length: 129 }, (_, index) => ({ type: 'text-delta', index, text: 'a' })), 'pdf/image-limit')
  await testStream([{ type: 'text-delta', index: 0, text: 'a'.repeat(MAX_DERIVED_TEXT_CHARACTERS + 1) }], 'pdf/image-limit')
})
