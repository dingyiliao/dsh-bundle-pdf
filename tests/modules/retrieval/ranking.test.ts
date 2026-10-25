import assert from 'node:assert/strict'
import test from 'node:test'
import { cosineSimilarity, createBm25Index, hybridCandidates, rankVectors, reciprocalRankFusion, searchBm25, validateEmbeddingVector } from '../../../src/modules/retrieval/ranking.ts'
import { createBm25IndexCooperatively, rankVectorsCooperatively, searchBm25Cooperatively } from '../../../src/modules/retrieval/ranking.ts'

test('BM25 uses corpus rarity, term frequency saturation and document length normalization', () => {
  const index = createBm25Index([
    { id: 'a', text: 'causal identification' },
    { id: 'b', text: `causal ${'general '.repeat(100)}` },
    { id: 'c', text: 'causal general' },
  ])
  assert.equal(searchBm25(index, 'causal identification')[0]!.chunkId, 'a')
  assert.ok(searchBm25(index, 'identification')[0]!.score > searchBm25(index, 'causal')[0]!.score)
  const causal = searchBm25(index, 'causal')
  assert.ok(causal.find(item => item.chunkId === 'a')!.score > causal.find(item => item.chunkId === 'b')!.score)
  assert.deepEqual(searchBm25(index, 'causal causal'), causal)
  assert.deepEqual(searchBm25(index, 'absent'), [])
})

test('BM25 matches Chinese query substrings and mixed full-width Latin without altering source', () => {
  const index = createBm25Index([
    { id: 'network', text: '本章介绍卷积神经网络的训练方法。ＰＤＦ' },
    { id: 'statistics', text: '本章介绍随机事件和概率模型。' },
  ])
  assert.equal(searchBm25(index, 'PDF 神经网络训练')[0]!.chunkId, 'network')
  assert.deepEqual(searchBm25(index, 'eigenvalue'), [])
  assert.deepEqual(searchBm25(createBm25Index([]), 'query'), [])
  assert.deepEqual(searchBm25(createBm25Index([{ id: 'empty', text: '...' }]), 'query'), [])
  assert.deepEqual(searchBm25(index, 'PDF', 0), [])
  assert.throws(() => searchBm25(index, 'PDF', Number.NaN), /limit/)
  assert.throws(() => createBm25Index([{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }]), /Duplicate/)
})

test('cosine ranking handles typed arrays, opposite directions and extreme finite magnitudes', () => {
  assert.equal(validateEmbeddingVector(new Float32Array([1, 2]), 2), 2)
  assert.equal(cosineSimilarity([1, 0], [10, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1)
  assert.ok(Math.abs(cosineSimilarity([1e308, 1e308], [1e-300, 1e-300]) - 1) < 1e-12)
  assert.deepEqual(rankVectors([1, 0], [
    { chunkId: 'negative', vector: [-1, 0] },
    { chunkId: 'orthogonal', vector: new Float32Array([0, 1]) },
    { chunkId: 'same', vector: [2, 0] },
  ]).map(item => item.chunkId), ['same', 'orthogonal', 'negative'])
})

test('invalid vectors are rejected rather than silently corrupting semantic ranking', () => {
  for (const vector of [[], [0, 0], [NaN, 1], [Infinity, 1], [undefined, 1]]) {
    assert.throws(() => validateEmbeddingVector(vector as number[]))
  }
  assert.throws(() => cosineSimilarity([1, 0], [1]), /dimensions/)
  assert.throws(() => rankVectors([1, 0], [{ chunkId: 'a', vector: [0, 0] }]), /nonzero/)
  assert.throws(() => rankVectors([0, 0], []), /nonzero/)
  assert.throws(() => rankVectors([1], [{ chunkId: 'a', vector: [1] }, { chunkId: 'a', vector: [1] }]), /Duplicate/)
})

test('RRF fuses ranks independently of raw score scales and deduplicates each source', () => {
  const lexical = [{ chunkId: 'a', score: 100000 }, { chunkId: 'b', score: 1 }]
  const semantic = [{ chunkId: 'b', score: 0.9 }, { chunkId: 'c', score: 0.8 }]
  const fused = reciprocalRankFusion([lexical, semantic])
  assert.equal(fused[0]!.chunkId, 'b')
  assert.equal(fused[0]!.score, 1 / 62 + 1 / 61)
  assert.deepEqual(reciprocalRankFusion([
    lexical.map(item => ({ ...item, score: item.score / 1e9 })),
    semantic.map(item => ({ ...item, score: item.score * 1e9 })),
  ]), fused)
  assert.deepEqual(reciprocalRankFusion([[lexical[0]!, lexical[0]!, lexical[1]!], semantic]), fused)
  assert.deepEqual(reciprocalRankFusion([lexical, semantic], 1), fused.slice(0, 1))
  assert.deepEqual(reciprocalRankFusion([]), [])
})

test('hybrid candidates preserve cross-language leaders despite incidental lexical overlap', () => {
  const lexical = Array.from({ length: 12 }, (_, index) => ({ chunkId: `incidental-word-${index}`, score: 100 - index }))
  const semantic = [{ chunkId: 'translated-concept', score: 0.91 }, { chunkId: 'translated-context', score: 0.88 },
    ...lexical.map((hit, index) => ({ ...hit, score: 0.2 - index * 0.01 }))]
  assert.ok(!reciprocalRankFusion([lexical, semantic], 5).some(hit => hit.chunkId === 'translated-concept'))
  const selected = hybridCandidates(lexical, semantic, 5).map(hit => hit.chunkId)
  assert.ok(selected.includes('translated-concept'))
  assert.ok(selected.includes('translated-context'))
  assert.ok(selected.includes('incidental-word-0'))
  assert.equal(selected.length, 5)
})

test('hybrid candidates protect an exact identifier only present in the lexical leader', () => {
  const semantic = Array.from({ length: 12 }, (_, index) => ({ chunkId: `meaning-${index}`, score: 0.9 - index * 0.01 }))
  const lexical = [{ chunkId: 'serial-ZX7814', score: 80 }, ...semantic.map((hit, index) => ({ ...hit, score: 10 - index / 10 }))]
  const selected = hybridCandidates(lexical, semantic, 5).map(hit => hit.chunkId)
  assert.ok(selected.includes('serial-ZX7814'))
  assert.ok(selected.includes('meaning-0'))
  assert.ok(selected.includes('meaning-1'))
})

test('hybrid coverage policy handles duplicate leaders, empty branches and one available slot', () => {
  const lexical = [{ chunkId: 'exact', score: 100 }, { chunkId: 'shared', score: 50 }]
  const semantic = [{ chunkId: 'meaning', score: 0.9 }, { chunkId: 'meaning', score: 0.8 }, { chunkId: 'shared', score: 0.7 }]
  assert.deepEqual(hybridCandidates(lexical, semantic, 1).map(hit => hit.chunkId), ['meaning'])
  assert.deepEqual(new Set(hybridCandidates(lexical, semantic, 2).map(hit => hit.chunkId)), new Set(['meaning', 'exact']))
  assert.equal(hybridCandidates(lexical, semantic, 3).length, 3)
  assert.equal(hybridCandidates([], semantic, 5).length, 2)
  assert.deepEqual(hybridCandidates(lexical, [], 1).map(hit => hit.chunkId), ['exact'])
  assert.deepEqual(hybridCandidates(lexical, semantic, 0), [])
  assert.throws(() => hybridCandidates(lexical, semantic, -1), /limit/)
})

test('cooperative algorithms match synchronous results and allow an interactive turn', async () => {
  const chunks = Array.from({ length: 200 }, (_, index) => ({ id: String(index), text: `PDF 中文原文 cat ${'cat '.repeat(index % 9)}` }))
  let turns = 0
  setImmediate(() => { turns++ })
  const index = await createBm25IndexCooperatively(chunks)
  assert.equal(turns, 1)
  assert.deepEqual(index, createBm25Index(chunks))
  const query = 'PDF 中文 原文 cat'
  assert.deepEqual(await searchBm25Cooperatively(index, query), searchBm25(index, query))
  const vectors = chunks.map((chunk, item) => ({ chunkId: chunk.id, vector: [item + 1, 1] }))
  assert.deepEqual(await rankVectorsCooperatively([1, 2], vectors), rankVectors([1, 2], vectors))
})

test('cooperative building, scoring and vector ranking stop at cancellation checkpoints', async () => {
  const chunks = Array.from({ length: 2000 }, (_, index) => ({ id: String(index), text: 'cat 中文 PDF search' }))
  const index = createBm25Index(chunks)
  const vectors = chunks.map(chunk => ({ chunkId: chunk.id, vector: [1, 2] }))
  for (const operation of [
    (signal: AbortSignal) => createBm25IndexCooperatively(chunks, signal),
    (signal: AbortSignal) => searchBm25Cooperatively(index, 'cat 中文 PDF', 30, signal),
    (signal: AbortSignal) => rankVectorsCooperatively([1, 2], vectors, 30, signal),
  ]) {
    const abort = new AbortController()
    setImmediate(() => abort.abort(new Error('Interrupted by user')))
    await assert.rejects(operation(abort.signal), /Interrupted by user/)
  }
})

test('cooperative checkpoints can reject a changed source before returning ranking', async () => {
  const chunks = Array.from({ length: 200 }, (_, index) => ({ id: String(index), text: 'original page text' }))
  let current = true
  setImmediate(() => { current = false })
  await assert.rejects(createBm25IndexCooperatively(chunks, undefined, () => {
    if (!current) throw new Error('Source changed')
  }), /Source changed/)
})
